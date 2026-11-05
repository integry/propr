import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, afterEach, beforeEach, describe, test } from 'node:test';
import { readFileSync } from 'node:fs';
import express from 'express';
import type { Request } from 'express';
import knex, { type Knex } from 'knex';
import { up as createInstanceMemberTables } from '../../core/src/db/migrations/20260730000000_create_instance_members.js';
import { ensureAuthenticated } from '../auth.js';
import { resolveAuthorization } from '../authorization.js';
import { createApiRequestRateLimiter } from '../requestRateLimits.js';
import { createQueueRoutes } from '../routes/queueRoutes.js';
import { createStatusRoutes } from '../routes/statusRoutes.js';
import {
    createHostedFleetRoutes,
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

function wiredApp(secret: string, rateLimitMax = 600) {
    const app = express();
    // Match production ordering: limit requests before Fleet and OAuth authentication.
    app.use('/api', createApiRequestRateLimiter({
        PROPR_API_RATE_LIMIT_MAX: String(rateLimitMax),
        PROPR_API_RATE_LIMIT_WINDOW_MS: '60000',
    }));
    const statusRoutes = createStatusRoutes({
        redisClient: {
            ping: async () => 'PONG',
            get: async (key: string) => key === 'system:status:routing' ? null : Date.now().toString(),
            sCard: async () => 1,
        } as never,
        loadAgents: async () => [],
        agentRegistry: {
            ensureInitialized: async () => undefined,
            getAllAgents: () => [],
            getAgentById: () => undefined,
            getAgentByAlias: () => undefined,
            createAgentFromConfig: () => { throw new Error('not used'); },
        } as never,
        getIndexingQueue: async () => ({ getJobCounts: async () => ({}) }),
        loadSummarizationRuntimeState: async () => ({
            primary_quota_failures: 0,
            primary_quota_failures_by_alias: {},
            cooldowns: {},
        }),
    });
    const queueRoutes = createQueueRoutes({
        redisClient: {} as never,
        taskQueue: {
            getWaitingCount: async () => 2,
            getActiveCount: async () => 1,
            // Fleet consumes only waiting/active; other counts must not be read.
            getCompletedCount: async () => { throw new Error('completed count not needed'); },
            getFailedCount: async () => { throw new Error('failed count not needed'); },
            getDelayedCount: async () => { throw new Error('delayed count not needed'); },
        } as never,
    });
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
        operationalStatus: statusRoutes.readStatusSnapshot,
        queueStatus: queueRoutes.collectQueueStats,
    });
    app.use('/api', ensureAuthenticated, resolveAuthorization);
    return { app, registered };
}

describe('hosted fleet Express wiring', () => {
    test('rate-limits requests before Fleet and OAuth authentication', async () => {
        for (const secret of [fleetSecret, '']) {
            for (const path of ['/api/internal/hosted/bootstrap', '/api/internal/hosted/status', '/api/internal/hosted/queue']) {
                const { app } = wiredApp(secret, 1);
                const unauthorized = await fetchFromApp(app, path);
                assert.equal(unauthorized.status, 401, path);
                assert.deepEqual(await unauthorized.json(), {
                    error: secret ? 'Fleet authentication required' : 'Unauthorized',
                });

                const limited = await fetchFromApp(app, path, {
                    headers: { 'x-propr-fleet-secret': fleetSecret },
                });
                assert.equal(limited.status, 429, path);
                assert.deepEqual(await limited.json(), {
                    code: 'RATE_LIMIT_EXCEEDED',
                    error: 'Too many requests. Please try again later.',
                });
            }
        }
    });

    test('server mounts the general /api limiter before setupRoutes registers hosted routes', () => {
        const source = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
        const limiter = source.indexOf("app.use('/api', createApiRequestRateLimiter());");
        const setupRoutesBody = source.indexOf('function setupRoutes(): void {');
        const hostedRegistration = source.indexOf('registerHostedFleetRoutes(app, {', setupRoutesBody);
        const setupRoutesCall = source.indexOf('    setupRoutes();');
        assert.ok(limiter >= 0 && setupRoutesBody >= 0 && hostedRegistration > setupRoutesBody);
        assert.ok(limiter < setupRoutesCall, 'general /api limiter must be installed before setupRoutes() runs');
    });

    test('warns at startup without logging values when Fleet control is misconfigured', () => {
        const warnings: string[] = [];
        const allWarnings: string[] = [];
        const originalWarn = console.warn;
        console.warn = (...args: unknown[]) => {
            const message = args.map(String).join(' ');
            warnings.push(message);
            allWarnings.push(message);
        };
        const register = (deps: HostedFleetRoutesDeps) => {
            warnings.length = 0;
            return registerHostedFleetRoutes({ get: () => undefined } as never, { database, ...deps });
        };
        try {
            assert.equal(register({ fleetSecret: '', initialAdminGithubUserId: '100' }), false);
            assert.deepEqual(warnings, []);

            const shortSecret = 'short-secret-value';
            assert.equal(register({ fleetSecret: shortSecret, initialAdminGithubUserId: '100' }), false);
            assert.equal(warnings.length, 1);
            assert.match(warnings[0], /PROPR_FLEET_CONTROL_SECRET .*shorter than 32/);

            const paddedSecret = ` ${fleetSecret}\n`;
            assert.equal(register({ fleetSecret: paddedSecret, initialAdminGithubUserId: '100' }), true);
            assert.equal(warnings.length, 1);
            assert.match(warnings[0], /PROPR_FLEET_CONTROL_SECRET has leading or trailing whitespace/);

            for (const initialAdminGithubUserId of ['', 'not-a-github-id', '0']) {
                assert.equal(register({ fleetSecret, initialAdminGithubUserId }), true);
                assert.equal(warnings.length, 1, initialAdminGithubUserId);
                assert.match(warnings[0], /PROPR_HOSTED_INITIAL_ADMIN_GITHUB_USER_ID is unset or invalid/);
            }

            assert.equal(register({ fleetSecret, initialAdminGithubUserId: '0100' }), true);
            assert.deepEqual(warnings, []);

            for (const value of [shortSecret, fleetSecret, 'not-a-github-id']) {
                assert.ok(allWarnings.every(warning => !warning.includes(value)));
            }
        } finally {
            console.warn = originalWarn;
        }
    });

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
            const body = await response.json() as Record<string, unknown>;
            if (path.endsWith('/status')) {
                assert.deepEqual(Object.keys(body).sort(), [
                    'githubAuth', 'githubAuthMode', 'githubEventIntake', 'githubEventIntakeStatus',
                ]);
            } else if (path.endsWith('/queue')) {
                assert.deepEqual(body, { waiting: 2, active: 1 });
            }
        }
    });
});
