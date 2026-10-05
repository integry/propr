import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, afterEach, beforeEach, describe, test } from 'node:test';
import { readFileSync } from 'node:fs';
import express from 'express';
import type { Request, Response } from 'express';
import knex, { type Knex } from 'knex';
import { up as createInstanceMemberTables } from '../../core/src/db/migrations/20260730000000_create_instance_members.js';
import { ensureAuthenticated } from '../auth.js';
import { resolveAuthorization } from '../authorization.js';
import { createApiRequestRateLimiter } from '../requestRateLimits.js';
import { createQueueRoutes } from '../routes/queueRoutes.js';
import { createStatusRoutes } from '../routes/statusRoutes.js';
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
        operationalStatus: () => ({
            githubAuthMode: 'relay',
            githubAuth: 'connected',
            githubEventIntake: 'routing_websocket',
            githubEventIntakeStatus: 'connected',
            redis: 'connected',
            routing: { routingUrl: 'wss://internal.example.test' },
        }),
        queueStatus: () => ({ waiting: 2, active: 1, completed: 20, failed: 3, delayed: 4, total: 30 }),
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

    test('rejects missing, non-positive, and unreasonably large initial administrator IDs', async () => {
        for (const initialAdminGithubUserId of ['', 'not-a-github-id', '0', '000', '-1', '1.5', '1'.repeat(21)]) {
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

    test('returns a stable 503 response when the durable administrator lookup fails', async () => {
        const failingDatabase = (() => {
            const query = {
                select: () => query,
                where: () => query,
                first: async () => { throw new Error('sensitive database failure'); },
            };
            return query;
        }) as unknown as Knex;
        const originalConsoleError = console.error;
        console.error = () => undefined;
        try {
            const { response, record } = recorder();
            await routes({ database: failingDatabase }).getBootstrapStatus(fleetRequest(fleetSecret), response);
            assert.equal(record.status, 503);
            assert.deepEqual(record.body, { error: 'Bootstrap status is unavailable' });
            assert.equal(record.headers['cache-control'], 'no-store');
        } finally {
            console.error = originalConsoleError;
        }
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

    test('preserves valid GitHub IDs larger than the JavaScript safe-integer range', async () => {
        const initialAdminGithubUserId = '9007199254740993';
        const { response, record } = recorder();
        await routes({ initialAdminGithubUserId }).getBootstrapStatus(fleetRequest(fleetSecret), response);

        assert.equal((record.body as Record<string, unknown>).initialAdminGithubUserId, initialAdminGithubUserId);
        assert.equal((record.body as Record<string, unknown>).durableAdminVerified, false);
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

    test('returns 503 when status collectors are unavailable', async () => {
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

    test('rejects malformed and unbounded operational status values', async () => {
        const valid = {
            githubAuthMode: 'relay',
            githubAuth: 'connected',
            githubEventIntake: 'routing_websocket',
            githubEventIntakeStatus: 'connected',
        };
        const malformedValues = [
            { ...valid, githubAuthMode: 42 },
            { ...valid, githubAuth: null },
            { ...valid, githubEventIntake: ['routing_websocket'] },
            { ...valid, githubEventIntakeStatus: false },
            { ...valid, githubEventIntakeStatus: 'x'.repeat(256) },
        ];

        for (const value of malformedValues) {
            const result = recorder();
            await routes({ operationalStatus: () => value }).getOperationalStatus(
                fleetRequest(fleetSecret),
                result.response
            );
            assert.equal(result.record.status, 503);
            assert.deepEqual(result.record.body, { error: 'Operational status is unavailable' });
        }
    });

    test('rejects non-integer and negative queue counts', async () => {
        for (const value of [
            { waiting: -1, active: 0 },
            { waiting: 0.5, active: 0 },
            { waiting: 0, active: -1 },
            { waiting: 0, active: 1.5 },
        ]) {
            const result = recorder();
            await routes({ queueStatus: () => value }).getQueueStatus(fleetRequest(fleetSecret), result.response);
            assert.equal(result.record.status, 503);
            assert.deepEqual(result.record.body, { error: 'Queue status is unavailable' });
        }
    });

    test('sanitizes invalid collector results and catches thrown failures as 503 responses', async () => {
        const invalidResult = recorder();
        await routes({
            operationalStatus: () => ({ error: 'sensitive backend detail', credential: 'do-not-expose' }),
        }).getOperationalStatus(fleetRequest(fleetSecret), invalidResult.response);
        assert.equal(invalidResult.record.status, 503);
        assert.deepEqual(invalidResult.record.body, { error: 'Operational status is unavailable' });

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
