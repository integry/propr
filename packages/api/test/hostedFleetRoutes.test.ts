import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, test } from 'node:test';
import type { Request, Response } from 'express';
import knex, { type Knex } from 'knex';
import { up as createInstanceMemberTables } from '../../core/src/db/migrations/20260730000000_create_instance_members.js';
import { createHostedFleetRoutes, isHostedFleetControlEnabled } from '../routes/hostedFleetRoutes.js';

const fleetSecret = 'fleet-control-secret-with-at-least-32-bytes';
let database: Knex;
let previousAdminUsers: string | undefined;

beforeEach(async () => {
    previousAdminUsers = process.env.PROPR_ADMIN_USERS;
    process.env.PROPR_ADMIN_USERS = 'owner';
    database = knex({
        client: 'better-sqlite3',
        connection: { filename: ':memory:' },
        useNullAsDefault: true
    });
    await createInstanceMemberTables(database);
});

afterEach(async () => {
    await database.destroy();
    if (previousAdminUsers === undefined) delete process.env.PROPR_ADMIN_USERS;
    else process.env.PROPR_ADMIN_USERS = previousAdminUsers;
});

after(async () => {
    const { closeConnection, shutdownQueue } = await import('@propr/core');
    await closeConnection();
    await shutdownQueue();
});

function request(secret?: string): Request {
    return {
        get(name: string) {
            return name.toLowerCase() === 'x-propr-fleet-secret' ? secret : undefined;
        }
    } as Request;
}

function recorder() {
    const record: { status: number; body?: Record<string, unknown>; headers: Record<string, string> } = {
        status: 200,
        headers: {}
    };
    const response = {
        status(code: number) { record.status = code; return response; },
        json(body: Record<string, unknown>) { record.body = body; return response; },
        setHeader(name: string, value: string) { record.headers[name.toLowerCase()] = value; return response; }
    } as unknown as Response;
    return { response, record };
}

function routes() {
    return createHostedFleetRoutes({
        database,
        fleetSecret,
        initialAdminGithubUserId: '100',
        initialAdminGithubLogin: 'owner',
        githubUserWhitelist: 'owner',
        operationalStatus: (_req, res) => {
            res.json({
                githubAuthMode: 'relay',
                githubAuth: 'connected',
                githubEventIntake: 'routing_websocket',
                githubEventIntakeStatus: 'connected'
            });
        },
        queueStatus: (_req, res) => { res.json({ waiting: 2, active: 1 }); }
    });
}

describe('hosted fleet bootstrap status', () => {
    test('requires a valid fleet control secret before routes are enabled', () => {
        const previousFleetSecret = process.env.PROPR_FLEET_CONTROL_SECRET;
        try {
            delete process.env.PROPR_FLEET_CONTROL_SECRET;
            assert.equal(isHostedFleetControlEnabled(), false);
            process.env.PROPR_FLEET_CONTROL_SECRET = 'x'.repeat(31);
            assert.equal(isHostedFleetControlEnabled(), false);
            process.env.PROPR_FLEET_CONTROL_SECRET = 'x'.repeat(32);
            assert.equal(isHostedFleetControlEnabled(), true);
        } finally {
            if (previousFleetSecret === undefined) delete process.env.PROPR_FLEET_CONTROL_SECRET;
            else process.env.PROPR_FLEET_CONTROL_SECRET = previousFleetSecret;
        }
    });

    test('rejects missing and incorrect service credentials', async () => {
        for (const supplied of [undefined, 'wrong-secret']) {
            const { response, record } = recorder();
            await routes().getBootstrapStatus(request(supplied), response);
            assert.equal(record.status, 401);
            assert.deepEqual(record.body, { error: 'Fleet authentication required' });
        }
    });

    test('reports a pending durable claim without exposing the login', async () => {
        const { response, record } = recorder();
        await routes().getBootstrapStatus(request(fleetSecret), response);

        assert.equal(record.status, 200);
        assert.deepEqual(record.body, {
            initialAdminGithubUserId: '100',
            durableAdminVerified: false,
            environmentBootstrapActive: true,
            whitelistOnlyInitialOwner: true
        });
        assert.equal(record.headers['cache-control'], 'no-store');
        assert.equal(JSON.stringify(record.body).includes('owner'), false);
    });

    test('verifies the durable administrator by immutable GitHub user ID', async () => {
        await database('instance_members').insert({
            github_user_id: '100',
            github_username: 'renamed-owner',
            role: 'admin',
            source: 'local'
        });
        process.env.PROPR_ADMIN_USERS = '';
        const { response, record } = recorder();
        await routes().getBootstrapStatus(request(fleetSecret), response);

        assert.equal(record.body?.durableAdminVerified, true);
        assert.equal(record.body?.environmentBootstrapActive, false);
    });

    test('does not accept a different administrator as the initial claim', async () => {
        await database('instance_members').insert({
            github_user_id: '200',
            github_username: 'another-admin',
            role: 'admin',
            source: 'local'
        });
        const { response, record } = recorder();
        await routes().getBootstrapStatus(request(fleetSecret), response);
        assert.equal(record.body?.durableAdminVerified, false);
    });

    test('protects the current operational status with the fleet credential', async () => {
        const unauthorized = recorder();
        await routes().getOperationalStatus(request(), unauthorized.response);
        assert.equal(unauthorized.record.status, 401);

        const authorized = recorder();
        await routes().getOperationalStatus(request(fleetSecret), authorized.response);
        assert.deepEqual(authorized.record.body, {
            githubAuthMode: 'relay',
            githubAuth: 'connected',
            githubEventIntake: 'routing_websocket',
            githubEventIntakeStatus: 'connected'
        });
        assert.equal(authorized.record.headers['cache-control'], 'no-store');

        const queue = recorder();
        await routes().getQueueStatus(request(fleetSecret), queue.response);
        assert.deepEqual(queue.record.body, { waiting: 2, active: 1 });
    });
});
