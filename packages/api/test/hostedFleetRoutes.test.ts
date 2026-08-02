import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, afterEach, beforeEach, describe, test } from 'node:test';
import express from 'express';
import type { Request, Response } from 'express';
import knex, { type Knex } from 'knex';
import { up as createInstanceMemberTables } from '../../core/src/db/migrations/20260730000000_create_instance_members.js';
import { ensureAuthenticated } from '../auth.js';
import { resolveAuthorization } from '../authorization.js';
import {
    createHostedFleetRoutes,
    isHostedFleetControlEnabled,
    registerHostedFleetRoutes,
} from '../routes/hostedFleetRoutes.js';

const fleetSecret = 'fleet-control-secret-with-at-least-32-bytes';
type HostedFleetRoutesDeps = NonNullable<Parameters<typeof createHostedFleetRoutes>[0]>;
let database: Knex;

beforeEach(async () => {
    database = knex({
        client: 'better-sqlite3',
        connection: { filename: ':memory:' },
        useNullAsDefault: true
    });
    await createInstanceMemberTables(database);
});

afterEach(async () => {
    await database.destroy();
});

after(async () => {
    const { closeConnection, shutdownQueue } = await import('@propr/core');
    await closeConnection();
    await shutdownQueue();
});

function fleetRequest(secret?: string): Request {
    return {
        get(name: string) {
            return name.toLowerCase() === 'x-propr-fleet-secret' ? secret : undefined;
        }
    } as Request;
}

function recorder() {
    const record: { status: number; body?: unknown; headers: Record<string, string> } = {
        status: 200,
        headers: {}
    };
    const response = {
        status(code: number) { record.status = code; return response; },
        json(body: unknown) { record.body = body; return response; },
        setHeader(name: string, value: string) { record.headers[name.toLowerCase()] = value; return response; }
    } as unknown as Response;
    return { response, record };
}

function routes(overrides: HostedFleetRoutesDeps = {}) {
    return createHostedFleetRoutes({
        database,
        fleetSecret,
        initialAdminGithubUserId: '100',
        initialAdminGithubLogin: 'owner',
        githubUserWhitelist: 'owner',
        bootstrapAdminUsernames: ['owner'],
        operationalStatus: (_req, res) => {
            res.json({
                githubAuthMode: 'relay',
                githubAuth: 'connected',
                githubEventIntake: 'routing_websocket',
                githubEventIntakeStatus: 'connected',
                redis: 'connected',
                routing: { routingUrl: 'wss://internal.example.test' },
            });
        },
        queueStatus: (_req, res) => {
            res.json({ waiting: 2, active: 1, completed: 20, failed: 3, delayed: 4, total: 30 });
        },
        ...overrides,
    });
}

async function fetchFromApp(
    app: express.Express,
    path: string,
    init?: RequestInit
): Promise<globalThis.Response> {
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    const { port } = server.address() as AddressInfo;
    try {
        return await fetch(`http://127.0.0.1:${port}${path}`, init);
    } finally {
        await new Promise<void>((resolve, reject) => {
            server.close(error => error ? reject(error) : resolve());
        });
    }
}

function wiredApp(secret: string) {
    const app = express();
    app.use((req, _res, next) => {
        req.isAuthenticated = (() => false) as Request['isAuthenticated'];
        next();
    });
    const registered = registerHostedFleetRoutes(app, {
        database,
        fleetSecret: secret,
        initialAdminGithubUserId: '100',
        initialAdminGithubLogin: 'owner',
        githubUserWhitelist: 'owner',
        bootstrapAdminUsernames: ['owner'],
        operationalStatus: (_req, res) => {
            res.json({
                githubAuthMode: 'relay',
                githubAuth: 'connected',
                githubEventIntake: 'routing_websocket',
                githubEventIntakeStatus: 'connected',
            });
        },
        queueStatus: (_req, res) => { res.json({ waiting: 2, active: 1 }); },
    });
    app.use('/api', ensureAuthenticated, resolveAuthorization);
    return { app, registered };
}

describe('hosted fleet bootstrap status', () => {
    test('requires a sufficiently long fleet control secret before routes are enabled', () => {
        assert.equal(isHostedFleetControlEnabled(''), false);
        assert.equal(isHostedFleetControlEnabled('x'.repeat(31)), false);
        assert.equal(isHostedFleetControlEnabled('x'.repeat(32)), true);
    });

    test('rejects missing, short, and same-length incorrect service credentials', async () => {
        for (const supplied of [undefined, 'wrong-secret', 'x'.repeat(fleetSecret.length)]) {
            const { response, record } = recorder();
            await routes().getBootstrapStatus(fleetRequest(supplied), response);
            assert.equal(record.status, 401);
            assert.deepEqual(record.body, { error: 'Fleet authentication required' });
            assert.equal(record.headers['cache-control'], 'no-store');
        }

        const queue = recorder();
        await routes().getQueueStatus(fleetRequest('wrong-secret'), queue.response);
        assert.equal(queue.record.status, 401);
        assert.deepEqual(queue.record.body, { error: 'Fleet authentication required' });
    });

    test('rejects missing or invalid initial administrator IDs', async () => {
        for (const initialAdminGithubUserId of ['', 'not-a-github-id']) {
            const { response, record } = recorder();
            await routes({ initialAdminGithubUserId }).getBootstrapStatus(fleetRequest(fleetSecret), response);
            assert.equal(record.status, 409);
            assert.deepEqual(record.body, { error: 'Hosted initial administrator is not configured' });
        }
    });

    test('reports a pending durable claim without exposing the login', async () => {
        const { response, record } = recorder();
        await routes().getBootstrapStatus(fleetRequest(fleetSecret), response);

        assert.equal(record.status, 200);
        assert.deepEqual(record.body, {
            initialAdminGithubUserId: '100',
            durableAdminVerified: false,
            environmentBootstrapActive: true,
            bootstrapOnlyInitialOwner: true,
            whitelistOnlyInitialOwner: true
        });
        assert.equal(record.headers['cache-control'], 'no-store');
        assert.equal(JSON.stringify(record.body).includes('owner'), false);
    });

    test('canonicalizes the configured GitHub ID before durable administrator lookup', async () => {
        await database('instance_members').insert({
            github_user_id: '100',
            github_username: 'renamed-owner',
            role: 'admin',
            source: 'local'
        });
        const { response, record } = recorder();
        await routes({
            initialAdminGithubUserId: ' 00100 ',
            bootstrapAdminUsernames: [],
        }).getBootstrapStatus(fleetRequest(fleetSecret), response);

        assert.equal((record.body as Record<string, unknown>).initialAdminGithubUserId, '100');
        assert.equal((record.body as Record<string, unknown>).durableAdminVerified, true);
        assert.equal((record.body as Record<string, unknown>).environmentBootstrapActive, false);
    });

    test('distinguishes removable owner-only bootstrap state from additional administrators', async () => {
        const duplicates = recorder();
        await routes({
            bootstrapAdminUsernames: [' owner ', 'OWNER'],
            githubUserWhitelist: 'Owner, OWNER',
        }).getBootstrapStatus(fleetRequest(fleetSecret), duplicates.response);
        assert.equal((duplicates.record.body as Record<string, unknown>).bootstrapOnlyInitialOwner, true);
        assert.equal((duplicates.record.body as Record<string, unknown>).whitelistOnlyInitialOwner, true);

        const additionalAdmins = recorder();
        await routes({
            bootstrapAdminUsernames: ['owner', 'break-glass-admin'],
            githubUserWhitelist: 'owner, break-glass-admin',
        }).getBootstrapStatus(fleetRequest(fleetSecret), additionalAdmins.response);
        assert.equal((additionalAdmins.record.body as Record<string, unknown>).environmentBootstrapActive, true);
        assert.equal((additionalAdmins.record.body as Record<string, unknown>).bootstrapOnlyInitialOwner, false);
        assert.equal((additionalAdmins.record.body as Record<string, unknown>).whitelistOnlyInitialOwner, false);
    });

    test('does not accept a different administrator as the initial claim', async () => {
        await database('instance_members').insert({
            github_user_id: '200',
            github_username: 'another-admin',
            role: 'admin',
            source: 'local'
        });
        const { response, record } = recorder();
        await routes().getBootstrapStatus(fleetRequest(fleetSecret), response);
        assert.equal((record.body as Record<string, unknown>).durableAdminVerified, false);
    });
});

describe('hosted fleet health status', () => {
    test('allowlists operational and queue response fields', async () => {
        const operational = recorder();
        await routes().getOperationalStatus(fleetRequest(fleetSecret), operational.response);
        assert.deepEqual(operational.record.body, {
            githubAuthMode: 'relay',
            githubAuth: 'connected',
            githubEventIntake: 'routing_websocket',
            githubEventIntakeStatus: 'connected'
        });
        assert.equal(operational.record.headers['cache-control'], 'no-store');

        const queue = recorder();
        await routes().getQueueStatus(fleetRequest(fleetSecret), queue.response);
        assert.deepEqual(queue.record.body, { waiting: 2, active: 1 });
        assert.equal(queue.record.headers['cache-control'], 'no-store');
    });

    test('returns 503 when delegated handlers are unavailable', async () => {
        const operational = recorder();
        await routes({ operationalStatus: undefined }).getOperationalStatus(
            fleetRequest(fleetSecret),
            operational.response
        );
        assert.equal(operational.record.status, 503);
        assert.deepEqual(operational.record.body, { error: 'Operational status is unavailable' });

        const queue = recorder();
        await routes({ queueStatus: undefined }).getQueueStatus(fleetRequest(fleetSecret), queue.response);
        assert.equal(queue.record.status, 503);
        assert.deepEqual(queue.record.body, { error: 'Queue status is unavailable' });
    });

    test('sanitizes delegated error responses and catches thrown failures', async () => {
        const delegatedFailure = recorder();
        await routes({
            operationalStatus: (_req, res) => {
                res.status(500).json({ error: 'sensitive backend detail', credential: 'do-not-expose' });
            },
        }).getOperationalStatus(fleetRequest(fleetSecret), delegatedFailure.response);
        assert.equal(delegatedFailure.record.status, 500);
        assert.deepEqual(delegatedFailure.record.body, { error: 'Operational status is unavailable' });

        const originalConsoleError = console.error;
        console.error = () => undefined;
        try {
            const thrownFailure = recorder();
            await routes({
                queueStatus: () => { throw new Error('sensitive queue failure'); },
            }).getQueueStatus(fleetRequest(fleetSecret), thrownFailure.response);
            assert.equal(thrownFailure.record.status, 503);
            assert.deepEqual(thrownFailure.record.body, { error: 'Queue status is unavailable' });
        } finally {
            console.error = originalConsoleError;
        }
    });
});

describe('hosted fleet Express wiring', () => {
    test('omits every hosted route when Fleet control is disabled', async () => {
        const { app, registered } = wiredApp('');
        assert.equal(registered, false);

        for (const path of ['/api/internal/hosted/bootstrap', '/api/internal/hosted/status', '/api/internal/hosted/queue']) {
            const response = await fetchFromApp(app, path);
            assert.equal(response.status, 401, path);
            assert.deepEqual(await response.json(), { error: 'Unauthorized' }, path);
        }
    });

    test('registers protected hosted routes before the OAuth boundary when enabled', async () => {
        const { app, registered } = wiredApp(fleetSecret);
        assert.equal(registered, true);

        const unauthorized = await fetchFromApp(app, '/api/internal/hosted/status');
        assert.equal(unauthorized.status, 401);
        assert.deepEqual(await unauthorized.json(), { error: 'Fleet authentication required' });

        for (const path of ['/api/internal/hosted/bootstrap', '/api/internal/hosted/status', '/api/internal/hosted/queue']) {
            const response = await fetchFromApp(app, path, {
                headers: { 'x-propr-fleet-secret': fleetSecret },
            });
            assert.equal(response.status, 200, path);
            assert.equal(response.headers.get('cache-control'), 'no-store', path);
        }
    });
});
