import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, test } from 'node:test';
import type { Request, Response } from 'express';
import knex, { type Knex } from 'knex';
import { up as createInstanceMemberTables } from '../../core/src/db/migrations/20260730000000_create_instance_members.js';
import {
    authenticatedUserResponse,
    resolveInstanceAuthorization,
    requirePermission,
    type InstanceAuthorization
} from '../authorization.js';
import { configureDemoMode, resetConfiguredDemoMode } from '../demoMode.js';
import { InstanceMemberError, InstanceMemberService } from '../instanceMemberService.js';
import { createAdminRoutes } from '../routes/adminRoutes.js';
import type { GitHubUser } from '../authTypes.js';
import { closeConnection } from '@propr/core';

after(async () => closeConnection());

const actor: GitHubUser = {
    id: '100',
    login: 'owner',
    username: 'owner',
    displayName: 'Owner',
    email: null,
    avatarUrl: null,
    accessToken: 'test-token'
};

const legacyAuthorization: InstanceAuthorization = {
    role: 'admin',
    permissions: ['instance.manage_agents', 'instance.manage_members', 'instance.manage_settings'],
    source: 'legacy',
    legacyMode: true
};

let database: Knex;
let originalAdminUsers: string | undefined;
let originalAnyRuntimeAdmin: string | undefined;

beforeEach(async () => {
    originalAdminUsers = process.env.PROPR_ADMIN_USERS;
    originalAnyRuntimeAdmin = process.env.PROPR_AGENT_RUNTIME_ADMIN_ANY_USER;
    delete process.env.PROPR_ADMIN_USERS;
    delete process.env.PROPR_AGENT_RUNTIME_ADMIN_ANY_USER;
    configureDemoMode(false);
    database = knex({
        client: 'better-sqlite3',
        connection: { filename: ':memory:' },
        useNullAsDefault: true
    });
    await createInstanceMemberTables(database);
});

afterEach(async () => {
    await database.destroy();
    if (originalAdminUsers === undefined) delete process.env.PROPR_ADMIN_USERS;
    else process.env.PROPR_ADMIN_USERS = originalAdminUsers;
    if (originalAnyRuntimeAdmin === undefined) delete process.env.PROPR_AGENT_RUNTIME_ADMIN_ANY_USER;
    else process.env.PROPR_AGENT_RUNTIME_ADMIN_ANY_USER = originalAnyRuntimeAdmin;
    resetConfiguredDemoMode();
});

function responseRecorder() {
    const record: { status: number; body?: unknown; ended: boolean } = { status: 200, ended: false };
    const response = {
        status(code: number) { record.status = code; return response; },
        json(body: unknown) { record.body = body; return response; },
        end() { record.ended = true; return response; }
    } as unknown as Response;
    return { response, record };
}

describe('instance authorization', () => {
    test('preserves existing installations in compatibility admin mode', async () => {
        const authorization = await resolveInstanceAuthorization(actor, database);

        assert.equal(authorization.role, 'admin');
        assert.equal(authorization.source, 'legacy');
        assert.equal(authorization.legacyMode, true);
        assert.equal(authorization.permissions.includes('instance.manage_settings'), true);
        assert.equal(authorization.permissions.includes('instance.manage_runtime'), false);
    });

    test('grants full admin permissions to PROPR_ADMIN_USERS', async () => {
        process.env.PROPR_ADMIN_USERS = 'someone, OWNER';

        const authorization = await resolveInstanceAuthorization(actor, database);

        assert.equal(authorization.role, 'admin');
        assert.equal(authorization.source, 'bootstrap');
        assert.equal(authorization.permissions.includes('instance.manage_runtime'), true);
    });

    test('defaults unassigned authenticated users to member after roles become explicit', async () => {
        await database('instance_members').insert({
            github_user_id: '200',
            github_username: 'another-admin',
            role: 'admin',
            source: 'local'
        });

        const authorization = await resolveInstanceAuthorization(actor, database);

        assert.equal(authorization.role, 'member');
        assert.equal(authorization.source, 'implicit');
        assert.deepEqual(authorization.permissions, []);
    });

    test('permission middleware rejects members with a stable error code', () => {
        const middleware = requirePermission('instance.manage_settings');
        const { response, record } = responseRecorder();
        let nextCalled = false;

        middleware(
            { authorization: { role: 'member', permissions: [], source: 'implicit', legacyMode: false } } as unknown as Request,
            response,
            () => { nextCalled = true; }
        );

        assert.equal(nextCalled, false);
        assert.equal(record.status, 403);
        assert.equal((record.body as { code: string }).code, 'INSUFFICIENT_INSTANCE_PERMISSION');
    });

    test('current-user responses expose capabilities without OAuth credentials', () => {
        const response = authenticatedUserResponse(actor, legacyAuthorization);

        assert.equal(response.role, 'admin');
        assert.equal(response.legacyAdminMode, true);
        assert.equal('accessToken' in response, false);
        assert.equal('refreshToken' in response, false);
    });
});

describe('instance member service', () => {
    test('claims the acting compatibility administrator and writes an audit entry', async () => {
        const service = new InstanceMemberService(database);

        const member = await service.claimAdmin(actor, legacyAuthorization);
        const audits = await service.listAudit();

        assert.equal(member.role, 'admin');
        assert.equal(member.githubUserId, actor.id);
        assert.equal(audits.length, 1);
        assert.equal(audits[0].action, 'admin_claimed');
    });

    test('persists the acting admin before adding the first member', async () => {
        const service = new InstanceMemberService(database);

        const member = await service.addMember(
            actor,
            legacyAuthorization,
            { id: '200', username: 'developer' },
            'member'
        );
        const members = await service.listMembers();

        assert.equal(member.role, 'member');
        assert.deepEqual(members.map(entry => [entry.githubUsername, entry.role]), [
            ['owner', 'admin'],
            ['developer', 'member']
        ]);
    });

    test('prevents removing the last administrator', async () => {
        const service = new InstanceMemberService(database);
        await service.claimAdmin(actor, legacyAuthorization);

        await assert.rejects(
            () => service.removeMember(actor, { ...legacyAuthorization, legacyMode: false }, actor.id),
            (error: unknown) =>
                error instanceof InstanceMemberError
                && error.code === 'LAST_ADMIN_REQUIRED'
                && error.status === 409
        );
    });

    test('allows role changes once another administrator exists', async () => {
        const service = new InstanceMemberService(database);
        await service.claimAdmin(actor, legacyAuthorization);
        await service.addMember(
            actor,
            { ...legacyAuthorization, legacyMode: false },
            { id: '200', username: 'second-admin' },
            'admin'
        );

        const updated = await service.updateRole(
            actor,
            { ...legacyAuthorization, legacyMode: false },
            actor.id,
            'member'
        );

        assert.equal(updated.role, 'member');
    });
});

describe('instance admin routes', () => {
    test('resolves a GitHub username and creates a durable member assignment', async () => {
        const routes = createAdminRoutes({
            database,
            services: {
                resolveGitHubUser: async username => ({ id: '200', username })
            }
        });
        const { response, record } = responseRecorder();

        await routes.addMember({
            body: { username: 'developer', role: 'member' },
            user: actor,
            authorization: legacyAuthorization
        } as Request, response);

        assert.equal(record.status, 201);
        assert.equal((record.body as { member: { githubUserId: string } }).member.githubUserId, '200');
        assert.equal((await database('instance_members').count<{ count: number }>({ count: '*' }).first())?.count, 2);
    });
});
