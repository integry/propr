import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, test } from 'node:test';
import type { Request, Response } from 'express';
import knex, { type Knex } from 'knex';
import { closeConnection } from '@propr/core';
import { up as createInstanceMemberTables } from '../../core/src/db/migrations/20260730000000_create_instance_members.js';
import {
    assertInstanceAdministratorConfigured,
    authenticatedUserResponse,
    resolveInstanceAuthorization,
    requirePermission,
    type InstanceAuthorization
} from '../authorization.js';
import { configureDemoMode, resetConfiguredDemoMode } from '../demoMode.js';
import { InstanceMemberError, InstanceMemberService } from '../instanceMemberService.js';
import { createAdminRoutes } from '../routes/adminRoutes.js';
import { createInstanceCatalogRoutes } from '../routes/instanceCatalogRoutes.js';
import type { GitHubUser } from '../authTypes.js';

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

const adminAuthorization: InstanceAuthorization = {
    role: 'admin',
    permissions: [
        'instance.manage_agents',
        'instance.manage_members',
        'instance.manage_runtime',
        'instance.manage_settings'
    ],
    source: 'local'
};

let database: Knex;
let originalAdminUsers: string | undefined;

beforeEach(async () => {
    originalAdminUsers = process.env.PROPR_ADMIN_USERS;
    delete process.env.PROPR_ADMIN_USERS;
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
    test('defaults unassigned authenticated users to members on a new installation', async () => {
        const authorization = await resolveInstanceAuthorization(actor, database);

        assert.equal(authorization.role, 'member');
        assert.equal(authorization.source, 'implicit');
        assert.deepEqual(authorization.permissions, []);
    });

    test('refuses startup until a bootstrap or durable administrator exists', async () => {
        await assert.rejects(
            () => assertInstanceAdministratorConfigured(database),
            /No instance administrator is configured/
        );

        process.env.PROPR_ADMIN_USERS = actor.username;
        await assert.doesNotReject(() => assertInstanceAdministratorConfigured(database));

        delete process.env.PROPR_ADMIN_USERS;
        await database('instance_members').insert({
            github_user_id: actor.id,
            github_username: actor.username,
            role: 'admin',
            source: 'local'
        });
        await assert.doesNotReject(() => assertInstanceAdministratorConfigured(database));
    });

    test('grants full admin permissions to PROPR_ADMIN_USERS', async () => {
        process.env.PROPR_ADMIN_USERS = 'someone, OWNER';

        const authorization = await resolveInstanceAuthorization(actor, database);

        assert.equal(authorization.role, 'admin');
        assert.equal(authorization.source, 'bootstrap');
        assert.equal(authorization.permissions.includes('instance.manage_runtime'), true);
    });

    test('resolves durable roles by numeric GitHub ID after a username change', async () => {
        await database('instance_members').insert({
            github_user_id: actor.id,
            github_username: 'old-owner-name',
            role: 'admin',
            source: 'local'
        });

        const authorization = await resolveInstanceAuthorization(actor, database);

        assert.equal(authorization.role, 'admin');
        assert.equal(authorization.source, 'local');
    });

    test('resolves demo users without installation permissions', async () => {
        configureDemoMode(true);

        const authorization = await resolveInstanceAuthorization(actor, database);

        assert.equal(authorization.source, 'demo');
        assert.deepEqual(authorization.permissions, []);
    });

    test('permission middleware rejects members with a stable error code', () => {
        const middleware = requirePermission('instance.manage_settings');
        const { response, record } = responseRecorder();
        let nextCalled = false;

        middleware(
            { authorization: { role: 'member', permissions: [], source: 'implicit' } } as unknown as Request,
            response,
            () => { nextCalled = true; }
        );

        assert.equal(nextCalled, false);
        assert.equal(record.status, 403);
        assert.equal((record.body as { code: string }).code, 'INSUFFICIENT_INSTANCE_PERMISSION');
    });

    test('current-user responses expose capabilities without OAuth credentials', () => {
        const response = authenticatedUserResponse(actor, adminAuthorization);

        assert.equal(response.role, 'admin');
        assert.equal(response.authorizationSource, 'local');
        assert.equal('accessToken' in response, false);
        assert.equal('refreshToken' in response, false);
    });
});

describe('instance member service', () => {
    test('does not let an unassigned user claim the initial administrator role', async () => {
        const service = new InstanceMemberService(database);
        const authorization = await resolveInstanceAuthorization(actor, database);

        await assert.rejects(
            () => service.claimBootstrapAdmin(actor, authorization),
            (error: unknown) =>
                error instanceof InstanceMemberError
                && error.code === 'BOOTSTRAP_ADMIN_REQUIRED'
                && error.status === 409
        );
        const countRow = await database('instance_members').count({ count: '*' }).first();
        assert.equal(Number(countRow?.count), 0);
    });

    test('stores a bootstrap administrator against their numeric GitHub ID', async () => {
        process.env.PROPR_ADMIN_USERS = actor.username;
        const service = new InstanceMemberService(database);
        const bootstrapAuthorization = await resolveInstanceAuthorization(actor, database);

        const member = await service.claimBootstrapAdmin(actor, bootstrapAuthorization);
        delete process.env.PROPR_ADMIN_USERS;
        const durableAuthorization = await resolveInstanceAuthorization(actor, database);

        assert.equal(member.githubUserId, actor.id);
        assert.equal(member.role, 'admin');
        assert.equal(durableAuthorization.source, 'local');
        assert.equal(durableAuthorization.role, 'admin');
        assert.equal((await service.listAudit())[0].action, 'admin_claimed');
    });

    test('adds explicit members and writes an audit entry', async () => {
        const service = new InstanceMemberService(database);

        const member = await service.addMember(actor, { id: '200', username: 'developer' }, 'member');
        const audits = await service.listAudit();

        assert.equal(member.role, 'member');
        assert.deepEqual((await service.listMembers()).map(entry => [entry.githubUsername, entry.role]), [
            ['developer', 'member']
        ]);
        assert.equal(audits[0].action, 'member_added');
    });

    test('keeps environment authority separate from durable role assignments', async () => {
        process.env.PROPR_ADMIN_USERS = 'developer';
        const service = new InstanceMemberService(database);
        const developer = { ...actor, id: '200', login: 'developer', username: 'Developer' };

        const member = await service.addMember(actor, developer, 'member');
        const effectiveAuthorization = await resolveInstanceAuthorization(developer, database);

        assert.equal(member.role, 'member');
        assert.equal(effectiveAuthorization.role, 'admin');
        assert.equal(effectiveAuthorization.source, 'bootstrap');
    });

    test('prevents removing the last durable administrator', async () => {
        process.env.PROPR_ADMIN_USERS = 'break-glass-admin';
        const service = new InstanceMemberService(database);
        await service.addMember(actor, actor, 'admin');

        await assert.rejects(
            () => service.removeMember(actor, actor.id),
            (error: unknown) =>
                error instanceof InstanceMemberError
                && error.code === 'LAST_ADMIN_REQUIRED'
                && error.status === 409
                && /last durable instance administrator/i.test(error.message)
        );
    });

    test('allows role changes once another administrator exists', async () => {
        const service = new InstanceMemberService(database);
        await service.addMember(actor, actor, 'admin');
        await service.addMember(actor, { id: '200', username: 'second-admin' }, 'admin');

        const updated = await service.updateRole(actor, actor.id, 'member');

        assert.equal(updated.role, 'member');
    });
});

describe('instance catalog', () => {
    test('returns operational agent and repository fields without installation internals', async () => {
        const routes = createInstanceCatalogRoutes({
            services: {
                loadAgents: async () => [{
                    id: 'agent-1',
                    type: 'codex',
                    alias: 'default',
                    enabled: true,
                    dockerImage: 'private.registry/agent:secret',
                    configPath: '/home/operator/.codex',
                    supportedModels: ['gpt-5.4'],
                    defaultModel: 'gpt-5.4',
                    envVars: { SECRET_TOKEN: 'secret' }
                }],
                loadRepositories: async () => [
                    { id: 'repo-1', name: 'integry/propr', enabled: true, baseBranch: 'main' },
                    { id: 'repo-2', name: 'integry/private-disabled', enabled: false }
                ],
                loadSettings: async () => ({
                    default_agent_alias: 'default',
                    github_user_whitelist: ['private-user']
                })
            }
        });
        const { response, record } = responseRecorder();

        await routes.getCatalog({} as Request, response);

        assert.equal(record.status, 200);
        assert.deepEqual(record.body, {
            agents: [{
                alias: 'default',
                enabled: true,
                supportedModels: ['gpt-5.4'],
                defaultModel: 'gpt-5.4'
            }],
            repositories: [{
                name: 'integry/propr',
                enabled: true,
                baseBranch: 'main'
            }],
            defaultAgentAlias: 'default'
        });
        const serialized = JSON.stringify(record.body);
        assert.doesNotMatch(serialized, /private\.registry|operator|SECRET_TOKEN|private-user|private-disabled/);
    });

    test('projects indexing status only for enabled repository and branch entries', async () => {
        const routes = createInstanceCatalogRoutes({
            services: {
                loadRepositories: async () => [
                    { id: 'repo-1', name: 'integry/propr', enabled: true, baseBranch: 'main' },
                    { id: 'repo-2', name: 'integry/disabled', enabled: false, baseBranch: 'main' }
                ],
                loadIndexingStatuses: async () => [
                    {
                        full_name: 'integry/propr',
                        branch: 'main',
                        indexing_status: 'completed',
                        last_indexed_at: '2026-07-30T00:00:00.000Z',
                        last_indexed_hash: 'abc123',
                        last_indexed_commit_message: 'Safe operational metadata',
                        icon_path: '/icons/propr.png',
                        internal_path: '/private/index'
                    },
                    {
                        full_name: 'integry/propr',
                        branch: 'private-branch',
                        indexing_status: 'completed',
                        last_indexed_at: null,
                        last_indexed_hash: null,
                        last_indexed_commit_message: null,
                        icon_path: null
                    },
                    {
                        full_name: 'integry/disabled',
                        branch: 'main',
                        indexing_status: 'failed',
                        last_indexed_at: null,
                        last_indexed_hash: null,
                        last_indexed_commit_message: null,
                        icon_path: null
                    }
                ] as never
            }
        });
        const { response, record } = responseRecorder();

        await routes.getRepositoryIndexingStatus({} as Request, response);

        assert.deepEqual(record.body, {
            repositories: [{
                full_name: 'integry/propr',
                branch: 'main',
                indexing_status: 'completed',
                last_indexed_at: '2026-07-30T00:00:00.000Z',
                last_indexed_hash: 'abc123',
                last_indexed_commit_message: 'Safe operational metadata',
                icon_path: '/icons/propr.png'
            }]
        });
        assert.doesNotMatch(JSON.stringify(record.body), /disabled|private-branch|internal_path|private\/index/);
    });
});

describe('instance admin routes', () => {
    test('resolves a GitHub username and creates one durable member assignment', async () => {
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
            authorization: adminAuthorization
        } as Request, response);

        assert.equal(record.status, 201);
        assert.equal((record.body as { member: { githubUserId: string } }).member.githubUserId, '200');
        assert.equal((await database('instance_members').count<{ count: number }>({ count: '*' }).first())?.count, 1);
    });

    test('rejects a non-numeric audit limit with a 400', async () => {
        const routes = createAdminRoutes({ database });
        const { response, record } = responseRecorder();

        await routes.listRoleAudit({ query: { limit: 'not-a-number' } } as unknown as Request, response);

        assert.equal(record.status, 400);
        assert.equal((record.body as { code: string }).code, 'INVALID_AUDIT_LIMIT');
    });

    test('rejects GitHub usernames with trailing or consecutive hyphens', async () => {
        const routes = createAdminRoutes({ database });
        for (const username of ['developer-', 'dev--eloper']) {
            const { response, record } = responseRecorder();
            await routes.addMember({
                body: { username, role: 'member' },
                user: actor,
                authorization: adminAuthorization
            } as Request, response);
            assert.equal(record.status, 400);
            assert.equal((record.body as { code: string }).code, 'INVALID_GITHUB_USERNAME');
        }
    });
});
