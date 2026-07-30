import type { Knex } from 'knex';
import type { GitHubUser } from './authTypes.js';
import type { InstanceAuthorization, InstanceRole } from './authorization.js';
import { getBootstrapAdminUsernames } from './authorization.js';

export interface InstanceMember {
    githubUserId: string;
    githubUsername: string;
    role: InstanceRole;
    source: 'local' | 'bootstrap' | 'managed';
    createdByUserId: string | null;
    createdAt: string;
    updatedAt: string;
}

export interface InstanceRoleAuditEntry {
    id: number;
    actorGithubUserId: string;
    actorGithubUsername: string;
    targetGithubUserId: string;
    targetGithubUsername: string;
    action: string;
    previousRole: InstanceRole | null;
    newRole: InstanceRole | null;
    createdAt: string;
}

interface MemberRow {
    github_user_id: string;
    github_username: string;
    role: InstanceRole;
    source: 'local' | 'bootstrap' | 'managed';
    created_by_user_id: string | null;
    created_at: string;
    updated_at: string;
}

interface AuditRow {
    id: number;
    actor_github_user_id: string;
    actor_github_username: string;
    target_github_user_id: string;
    target_github_username: string;
    action: string;
    previous_role: InstanceRole | null;
    new_role: InstanceRole | null;
    created_at: string;
}

interface AuditWrite {
    actor: GitHubUser;
    target: { id: string; username: string };
    action: string;
    previousRole: InstanceRole | null;
    newRole: InstanceRole | null;
}

export class InstanceMemberError extends Error {
    constructor(
        message: string,
        readonly status: number,
        readonly code: string
    ) {
        super(message);
        this.name = 'InstanceMemberError';
    }
}

function toMember(row: MemberRow): InstanceMember {
    return {
        githubUserId: row.github_user_id,
        githubUsername: row.github_username,
        role: row.role,
        source: row.source,
        createdByUserId: row.created_by_user_id,
        createdAt: row.created_at,
        updatedAt: row.updated_at
    };
}

function toAuditEntry(row: AuditRow): InstanceRoleAuditEntry {
    return {
        id: row.id,
        actorGithubUserId: row.actor_github_user_id,
        actorGithubUsername: row.actor_github_username,
        targetGithubUserId: row.target_github_user_id,
        targetGithubUsername: row.target_github_username,
        action: row.action,
        previousRole: row.previous_role,
        newRole: row.new_role,
        createdAt: row.created_at
    };
}

async function writeAudit(
    trx: Knex.Transaction,
    { actor, target, action, previousRole, newRole }: AuditWrite
): Promise<void> {
    await trx('instance_role_audit').insert({
        actor_github_user_id: actor.id,
        actor_github_username: actor.username,
        target_github_user_id: target.id,
        target_github_username: target.username,
        action,
        previous_role: previousRole,
        new_role: newRole
    });
}

async function persistActingAdmin(
    trx: Knex.Transaction,
    actor: GitHubUser,
    authorization: InstanceAuthorization
): Promise<void> {
    const existing = await trx<MemberRow>('instance_members')
        .where({ github_user_id: actor.id })
        .first();
    if (existing?.role === 'admin') {
        if (existing.github_username !== actor.username) {
            await trx('instance_members')
                .where({ github_user_id: actor.id })
                .update({ github_username: actor.username, updated_at: trx.fn.now() });
        }
        return;
    }

    const source = authorization.source === 'bootstrap' ? 'bootstrap' : 'local';
    if (existing) {
        await trx('instance_members')
            .where({ github_user_id: actor.id })
            .update({
                github_username: actor.username,
                role: 'admin',
                source,
                updated_at: trx.fn.now()
            });
        await writeAudit(trx, {
            actor,
            target: actor,
            action: 'admin_claimed',
            previousRole: existing.role,
            newRole: 'admin'
        });
        return;
    }

    await trx('instance_members').insert({
        github_user_id: actor.id,
        github_username: actor.username,
        role: 'admin',
        source,
        created_by_user_id: actor.id
    });
    await writeAudit(trx, {
        actor,
        target: actor,
        action: 'admin_claimed',
        previousRole: null,
        newRole: 'admin'
    });
}

function assertNotEnvironmentAdmin(member: MemberRow): void {
    if (getBootstrapAdminUsernames().includes(member.github_username.toLowerCase())) {
        throw new InstanceMemberError(
            `${member.github_username} is configured through PROPR_ADMIN_USERS and cannot be changed here`,
            409,
            'BOOTSTRAP_ADMIN_IMMUTABLE'
        );
    }
}

async function assertAnotherAdminExists(trx: Knex.Transaction): Promise<void> {
    const countRow = await trx('instance_members').where({ role: 'admin' }).count<{ count: number | string }>({ count: '*' }).first();
    if (Number(countRow?.count || 0) <= 1) {
        throw new InstanceMemberError(
            'The last instance administrator cannot be demoted or removed',
            409,
            'LAST_ADMIN_REQUIRED'
        );
    }
}

export class InstanceMemberService {
    constructor(private readonly database: Knex) {}

    async listMembers(): Promise<InstanceMember[]> {
        const rows = await this.database<MemberRow>('instance_members')
            .select('*')
            .orderByRaw("CASE WHEN role = 'admin' THEN 0 ELSE 1 END")
            .orderBy('github_username', 'asc');
        return rows.map(toMember);
    }

    async listAudit(limit = 100): Promise<InstanceRoleAuditEntry[]> {
        const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 250);
        const rows = await this.database<AuditRow>('instance_role_audit')
            .select('*')
            .orderBy('id', 'desc')
            .limit(safeLimit);
        return rows.map(toAuditEntry);
    }

    async claimAdmin(actor: GitHubUser, authorization: InstanceAuthorization): Promise<InstanceMember> {
        return this.database.transaction(async trx => {
            await persistActingAdmin(trx, actor, authorization);
            const row = await trx<MemberRow>('instance_members').where({ github_user_id: actor.id }).first();
            if (!row) throw new Error('Failed to persist the acting administrator');
            return toMember(row);
        });
    }

    async addMember(
        actor: GitHubUser,
        authorization: InstanceAuthorization,
        target: { id: string; username: string },
        role: InstanceRole
    ): Promise<InstanceMember> {
        return this.database.transaction(async trx => {
            await persistActingAdmin(trx, actor, authorization);
            const existing = await trx<MemberRow>('instance_members').where({ github_user_id: target.id }).first();
            if (existing) {
                throw new InstanceMemberError('This GitHub user already has an explicit instance role', 409, 'MEMBER_EXISTS');
            }
            await trx('instance_members').insert({
                github_user_id: target.id,
                github_username: target.username,
                role,
                source: 'local',
                created_by_user_id: actor.id
            });
            await writeAudit(trx, {
                actor,
                target,
                action: 'member_added',
                previousRole: null,
                newRole: role
            });
            const row = await trx<MemberRow>('instance_members').where({ github_user_id: target.id }).first();
            if (!row) throw new Error('Failed to add the instance member');
            return toMember(row);
        });
    }

    async updateRole(
        actor: GitHubUser,
        authorization: InstanceAuthorization,
        githubUserId: string,
        role: InstanceRole
    ): Promise<InstanceMember> {
        return this.database.transaction(async trx => {
            await persistActingAdmin(trx, actor, authorization);
            const existing = await trx<MemberRow>('instance_members').where({ github_user_id: githubUserId }).first();
            if (!existing) throw new InstanceMemberError('Instance member not found', 404, 'MEMBER_NOT_FOUND');
            assertNotEnvironmentAdmin(existing);
            if (existing.role === 'admin' && role !== 'admin') await assertAnotherAdminExists(trx);
            if (existing.role !== role) {
                await trx('instance_members')
                    .where({ github_user_id: githubUserId })
                    .update({ role, updated_at: trx.fn.now() });
                await writeAudit(trx, {
                    actor,
                    target: { id: existing.github_user_id, username: existing.github_username },
                    action: 'role_changed',
                    previousRole: existing.role,
                    newRole: role
                });
            }
            const row = await trx<MemberRow>('instance_members').where({ github_user_id: githubUserId }).first();
            if (!row) throw new Error('Failed to update the instance member');
            return toMember(row);
        });
    }

    async removeMember(
        actor: GitHubUser,
        authorization: InstanceAuthorization,
        githubUserId: string
    ): Promise<void> {
        await this.database.transaction(async trx => {
            await persistActingAdmin(trx, actor, authorization);
            const existing = await trx<MemberRow>('instance_members').where({ github_user_id: githubUserId }).first();
            if (!existing) throw new InstanceMemberError('Instance member not found', 404, 'MEMBER_NOT_FOUND');
            assertNotEnvironmentAdmin(existing);
            if (existing.role === 'admin') await assertAnotherAdminExists(trx);
            await trx('instance_members').where({ github_user_id: githubUserId }).delete();
            await writeAudit(trx, {
                actor,
                target: { id: existing.github_user_id, username: existing.github_username },
                action: 'member_removed',
                previousRole: existing.role,
                newRole: null
            });
        });
    }
}
