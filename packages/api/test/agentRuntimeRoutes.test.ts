import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, test } from 'node:test';
import type { Request, Response } from 'express';
import { createAgentRuntimeRoutes } from '../routes/agentRuntimeRoutes.js';
import { closeConnection, type AgentRuntimePackageState } from '@propr/core';

after(async () => closeConnection());

const originalAdminUsers = process.env.PROPR_ADMIN_USERS;
const originalAdminAnyUser = process.env.PROPR_AGENT_RUNTIME_ADMIN_ANY_USER;
const originalRuntimeRequestTimeoutMs = process.env.PROPR_AGENT_RUNTIME_REQUEST_TIMEOUT_MS;

beforeEach(() => {
    process.env.PROPR_ADMIN_USERS = 'admin';
    delete process.env.PROPR_AGENT_RUNTIME_ADMIN_ANY_USER;
});

afterEach(() => {
    if (originalAdminUsers === undefined) delete process.env.PROPR_ADMIN_USERS;
    else process.env.PROPR_ADMIN_USERS = originalAdminUsers;
    if (originalAdminAnyUser === undefined) delete process.env.PROPR_AGENT_RUNTIME_ADMIN_ANY_USER;
    else process.env.PROPR_AGENT_RUNTIME_ADMIN_ANY_USER = originalAdminAnyUser;
    if (originalRuntimeRequestTimeoutMs === undefined) delete process.env.PROPR_AGENT_RUNTIME_REQUEST_TIMEOUT_MS;
    else process.env.PROPR_AGENT_RUNTIME_REQUEST_TIMEOUT_MS = originalRuntimeRequestTimeoutMs;
});

const initialState = (): AgentRuntimePackageState => ({
    installationId: 'test-installation',
    packages: [],
    activePackages: [],
    status: 'disabled',
    images: {},
    updatedAt: '2026-07-15T00:00:00.000Z'
});

function responseRecorder() {
    const record: { status: number; body?: unknown } = { status: 200 };
    const response = {
        status(code: number) { record.status = code; return response; },
        json(body: unknown) { record.body = body; return response; }
    } as unknown as Response;
    return { response, record };
}

const availablePackages = async (packages: unknown) => ({
    valid: true,
    packages: packages as string[],
    errors: [],
    availability: [],
    sources: []
});

describe('agent runtime package routes', () => {
    test('queues one validated package profile for the unified agent image', async () => {
        let state = initialState();
        let queued: unknown;
        const routes = createAgentRuntimeRoutes({
            runtimeBuildQueue: { add: async (_name: string, data: unknown) => { queued = data; } } as never,
            services: {
                loadState: async () => state,
                loadBaseImages: async () => [
                    'propr/agent:bundle-test',
                    'propr/agent:bundle-test',
                    'propr/agent:bundle-test'
                ],
                requestBuild: async (packages, baseImages) => {
                    state = { ...state, packages: packages as string[], status: 'pending', buildId: 'build-1' };
                    return { buildId: 'build-1', packages: packages as string[], baseImages };
                },
                validateAvailability: availablePackages
            }
        });
        const { response, record } = responseRecorder();

        await routes.putRuntimePackages({ body: { packages: ['chromium'] }, user: { username: 'admin' } } as unknown as Request, response);

        assert.equal(record.status, 202);
        assert.deepEqual(queued, {
            buildId: 'build-1',
            packages: ['chromium'],
            baseImages: ['propr/agent:bundle-test']
        });
        assert.equal((record.body as AgentRuntimePackageState).status, 'pending');
        assert.equal((record.body as AgentRuntimePackageState & { canManage?: boolean }).canManage, true);
    });

    test('persists a failed state when queue submission fails', async () => {
        let state: AgentRuntimePackageState = { ...initialState(), packages: ['jq'], status: 'pending', buildId: 'build-2' };
        const routes = createAgentRuntimeRoutes({
            runtimeBuildQueue: { add: async () => { throw new Error('redis unavailable'); } } as never,
            services: {
                loadState: async () => state,
                loadBaseImages: async () => ['propr/agent:bundle-test'],
                requestBuild: async (_packages, baseImages) => ({ buildId: 'build-2', packages: ['jq'], baseImages }),
                saveState: async next => { state = next; },
                validateAvailability: availablePackages
            }
        });
        const { response, record } = responseRecorder();

        await routes.putRuntimePackages({ body: { packages: ['jq'] }, user: { username: 'admin' } } as unknown as Request, response);

        assert.equal(record.status, 500);
        assert.equal(state.status, 'failed');
        assert.equal(state.error, 'redis unavailable');
    });

    test('rejects a package missing from an effective runtime before queueing', async () => {
        let queued = false;
        const routes = createAgentRuntimeRoutes({
            runtimeBuildQueue: { add: async () => { queued = true; } } as never,
            services: {
                loadBaseImages: async () => ['propr/agent:bundle-test'],
                validateAvailability: async packages => ({
                    valid: false,
                    packages: packages as string[],
                    errors: ['not-real is unavailable on Debian 12'],
                    availability: [{ package: 'not-real', available: false, unavailableOn: ['Debian 12'] }],
                    sources: []
                })
            }
        });
        const { response, record } = responseRecorder();

        await routes.putRuntimePackages({ body: { packages: ['not-real'] }, user: { username: 'admin' } } as unknown as Request, response);

        assert.equal(record.status, 400);
        assert.equal(queued, false);
        assert.match((record.body as { error: string }).error, /unavailable on Debian 12/);
    });

    test('times out slow runtime package validation before queueing', async () => {
        process.env.PROPR_AGENT_RUNTIME_REQUEST_TIMEOUT_MS = '5';
        let queued = false;
        const routes = createAgentRuntimeRoutes({
            runtimeBuildQueue: { add: async () => { queued = true; } } as never,
            services: {
                loadBaseImages: async () => ['propr/agent:bundle-test'],
                validateAvailability: () => new Promise<never>(() => undefined)
            }
        });
        const { response, record } = responseRecorder();

        await routes.putRuntimePackages({ body: { packages: ['jq'] }, user: { username: 'admin' } } as unknown as Request, response);

        assert.equal(record.status, 504);
        assert.equal(queued, false);
        assert.match((record.body as { error: string }).error, /availability validation timed out/);
    });

    test('returns package suggestions from configured runtimes', async () => {
        const routes = createAgentRuntimeRoutes({
            runtimeBuildQueue: {} as never,
            services: {
                loadBaseImages: async () => ['propr/agent:bundle-test'],
                search: async query => ({ query, suggestions: ['chromium'], sources: [] })
            }
        });
        const { response, record } = responseRecorder();

        await routes.searchRuntimePackages({ query: { q: 'chrom' }, user: { username: 'admin' } } as unknown as Request, response);

        assert.deepEqual(record.body, { query: 'chrom', suggestions: ['chromium'], sources: [] });
    });

    test('enforces PROPR_ADMIN_USERS when configured', async () => {
        const previous = process.env.PROPR_ADMIN_USERS;
        process.env.PROPR_ADMIN_USERS = 'owner';
        try {
            const routes = createAgentRuntimeRoutes({ runtimeBuildQueue: {} as never });
            const { response, record } = responseRecorder();
            await routes.putRuntimePackages({ body: { packages: ['jq'] }, user: { username: 'member' } } as unknown as Request, response);
            assert.equal(record.status, 403);
        } finally {
            if (previous === undefined) delete process.env.PROPR_ADMIN_USERS;
            else process.env.PROPR_ADMIN_USERS = previous;
        }
    });

    test('denies runtime package changes by default when no admin policy is configured', async () => {
        delete process.env.PROPR_ADMIN_USERS;
        const routes = createAgentRuntimeRoutes({ runtimeBuildQueue: {} as never });
        const { response, record } = responseRecorder();

        await routes.putRuntimePackages({ body: { packages: ['jq'] }, user: { username: 'member' } } as unknown as Request, response);

        assert.equal(record.status, 403);
    });

    test('allows explicit any-authenticated-user runtime administration opt-in', async () => {
        delete process.env.PROPR_ADMIN_USERS;
        process.env.PROPR_AGENT_RUNTIME_ADMIN_ANY_USER = 'true';
        let queued = false;
        const routes = createAgentRuntimeRoutes({
            runtimeBuildQueue: { add: async () => { queued = true; } } as never,
            services: {
                loadState: async () => ({ ...initialState(), packages: ['jq'], status: 'pending', buildId: 'build-any' }),
                loadBaseImages: async () => ['propr/agent:bundle-test'],
                requestBuild: async (packages, baseImages) => ({ buildId: 'build-any', packages: packages as string[], baseImages }),
                validateAvailability: availablePackages
            }
        });
        const { response, record } = responseRecorder();

        await routes.putRuntimePackages({ body: { packages: ['jq'] }, user: { username: 'member' } } as unknown as Request, response);

        assert.equal(record.status, 202);
        assert.equal(queued, true);
    });

    test('redacts runtime build details for non-admin readers', async () => {
        const previous = process.env.PROPR_ADMIN_USERS;
        process.env.PROPR_ADMIN_USERS = 'owner';
        try {
            const routes = createAgentRuntimeRoutes({
                runtimeBuildQueue: {} as never,
                services: {
                    loadState: async () => ({
                        ...initialState(),
                        status: 'failed',
                        error: 'apt mirror exposed host details',
                        buildLog: 'full build log'
                    })
                }
            });
            const { response, record } = responseRecorder();

            await routes.getRuntimePackages({ user: { username: 'member' } } as unknown as Request, response);

            assert.equal(record.status, 200);
            assert.equal((record.body as AgentRuntimePackageState).status, 'failed');
            assert.equal((record.body as AgentRuntimePackageState).error, undefined);
            assert.equal((record.body as AgentRuntimePackageState).buildLog, undefined);
            assert.equal((record.body as AgentRuntimePackageState & { canManage?: boolean }).canManage, false);
        } finally {
            if (previous === undefined) delete process.env.PROPR_ADMIN_USERS;
            else process.env.PROPR_ADMIN_USERS = previous;
        }
    });

    test('requires authentication before returning runtime package state', async () => {
        const routes = createAgentRuntimeRoutes({
            runtimeBuildQueue: {} as never,
            services: {
                loadState: async () => ({
                    ...initialState(),
                    status: 'failed',
                    error: 'private build error',
                    buildLog: 'private build log'
                })
            }
        });
        const { response, record } = responseRecorder();

        await routes.getRuntimePackages({} as unknown as Request, response);

        assert.equal(record.status, 401);
        assert.deepEqual(record.body, { error: 'Authentication required' });
    });

    test('warms the package catalog when an admin loads runtime package state', async () => {
        let warmedImages: string[] | undefined;
        let resolveWarmed: (() => void) | undefined;
        const warmedPromise = new Promise<void>(resolve => { resolveWarmed = resolve; });
        const routes = createAgentRuntimeRoutes({
            runtimeBuildQueue: {} as never,
            services: {
                loadState: async () => initialState(),
                loadBaseImages: async () => ['propr/agent:bundle-test'],
                warmCatalog: images => { warmedImages = images; resolveWarmed?.(); }
            }
        });
        const { response, record } = responseRecorder();

        await routes.getRuntimePackages({ user: { username: 'admin' } } as unknown as Request, response);
        await warmedPromise;

        assert.equal(record.status, 200);
        assert.deepEqual(warmedImages, ['propr/agent:bundle-test']);
    });

    test('does not warm the package catalog for non-admin readers', async () => {
        let warmCalled = false;
        const routes = createAgentRuntimeRoutes({
            runtimeBuildQueue: {} as never,
            services: {
                loadState: async () => initialState(),
                loadBaseImages: async () => ['propr/agent:bundle-test'],
                warmCatalog: () => { warmCalled = true; }
            }
        });
        const { response, record } = responseRecorder();

        await routes.getRuntimePackages({ user: { username: 'member' } } as unknown as Request, response);
        await new Promise(resolve => setImmediate(resolve));

        assert.equal(record.status, 200);
        assert.equal(warmCalled, false);
    });

    test('resolves the runtime build queue lazily when queueing', async () => {
        let state = initialState();
        let queued: unknown;
        const queue = { add: async (_name: string, data: unknown) => { queued = data; } };
        const routes = createAgentRuntimeRoutes({
            getRuntimeBuildQueue: () => queue as never,
            services: {
                loadState: async () => state,
                loadBaseImages: async () => ['propr/agent:bundle-test'],
                requestBuild: async (packages, baseImages) => {
                    state = { ...state, packages: packages as string[], status: 'pending', buildId: 'build-lazy' };
                    return { buildId: 'build-lazy', packages: packages as string[], baseImages };
                },
                validateAvailability: availablePackages
            }
        });
        const { response, record } = responseRecorder();

        await routes.putRuntimePackages({ body: { packages: ['jq'] }, user: { username: 'admin' } } as unknown as Request, response);

        assert.equal(record.status, 202);
        assert.deepEqual(queued, {
            buildId: 'build-lazy',
            packages: ['jq'],
            baseImages: ['propr/agent:bundle-test']
        });
    });

    test('reports apply load failures through the route response', async () => {
        const routes = createAgentRuntimeRoutes({
            runtimeBuildQueue: {} as never,
            services: {
                loadState: async () => { throw new Error('state unavailable'); }
            }
        });
        const { response, record } = responseRecorder();

        await routes.applyRuntimePackages({ user: { username: 'admin' } } as unknown as Request, response);

        assert.equal(record.status, 500);
        assert.equal((record.body as { error: string }).error, 'state unavailable');
    });
});
