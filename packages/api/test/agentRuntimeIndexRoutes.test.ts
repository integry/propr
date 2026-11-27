import assert from 'node:assert/strict';
import { after, afterEach, test } from 'node:test';
import type { Request, Response } from 'express';
import { createAgentRuntimeRoutes } from '../routes/agentRuntimeRoutes.js';
import {
    AGENT_IMAGE_PACKAGE_BASE,
    DEFAULT_SPRITE_PACKAGE_BASE,
    closeConnection,
    createAgentImagePackageIndex,
    setAgentImagePackageIndexLoader,
    validateAgentRuntimePackagesWithIndex,
    type AgentImagePackageIndex,
    type AgentRuntimePackageState
} from '@propr/core';
import type { InstanceAuthorization } from '../authorization.js';

// Settings validation without Docker: package names are resolved against the agent image's
// Debian package index (see agentRuntimePackageIndex.ts); Docker is never called.

after(async () => closeConnection());
afterEach(() => setAgentImagePackageIndexLoader());

const packageIndex = (): AgentImagePackageIndex => createAgentImagePackageIndex(
    { 'postgresql-client': ['15+248'], figlet: ['2.2.5-3+b1'], postfix: ['3.7.11-0+deb12u1'] },
    ['mail-transport-agent', 'default-mta']
);

const initialState = (): AgentRuntimePackageState => ({
    installationId: 'test-installation',
    packages: [],
    activePackages: [],
    status: 'disabled',
    images: {},
    updatedAt: '2026-07-15T00:00:00.000Z'
});

const adminAuthorization: InstanceAuthorization = {
    role: 'admin',
    permissions: ['instance.manage_runtime'],
    source: 'local'
};

function responseRecorder() {
    const record: { status: number; body?: unknown } = { status: 200 };
    const response = {
        status(code: number) { record.status = code; return response; },
        json(body: unknown) { record.body = body; return response; }
    } as unknown as Response;
    return { response, record };
}

function remoteOnlyRoutes(queued: unknown[], overrides: Parameters<typeof createAgentRuntimeRoutes>[0]['services'] = {}) {
    let state = initialState();
    const dockerOnly = async () => { throw new Error('Cannot connect to the Docker daemon'); };
    return createAgentRuntimeRoutes({
        runtimeBuildQueue: { add: async (_name: string, data: unknown) => { queued.push(data); } } as never,
        services: {
            loadState: async () => state,
            loadBaseImages: async () => ['propr/agent:bundle-test'],
            remoteInstall: async () => 'Installed in a derived Fly Machine image; no Docker image is built',
            requestBuild: async (packages, baseImages) => {
                state = { ...state, packages: packages as string[], status: 'pending', buildId: 'build-index' };
                return { buildId: 'build-index', packages: packages as string[], baseImages };
            },
            validateAvailability: dockerOnly,
            validateWithIndex: validateAgentRuntimePackagesWithIndex,
            runtimeUsage: async () => ({ runtimes: ['fly-machines'], docker: false }),
            remoteTargets: async () => [],
            ...overrides
        }
    });
}
const adminRequest = (body?: unknown) => ({ body, query: {}, user: { username: 'admin' }, authorization: adminAuthorization }) as unknown as Request;

test('without Docker, unknown package names are refused at save, every bad name at once', async () => {
    setAgentImagePackageIndexLoader(async () => packageIndex());
    const queued: unknown[] = [];
    const routes = remoteOnlyRoutes(queued);

    const put = responseRecorder();
    await routes.putRuntimePackages(adminRequest({ packages: ['figlett', 'figlet', 'postgresql-clent'] }), put.response);
    assert.equal(put.record.status, 400);
    assert.deepEqual(queued, [], 'nothing is queued for a list the index rejects');
    const body = put.record.body as { error: string; errors: string[] };
    assert.deepEqual(body.errors, ['Unknown package: figlett', 'Unknown package: postgresql-clent']);
    assert.equal(body.error, 'Unknown package: figlett; Unknown package: postgresql-clent');

    const validated = responseRecorder();
    await routes.validateRuntimePackages(adminRequest({ packages: ['figlett'] }), validated.response);
    assert.equal(validated.record.status, 400);
    assert.deepEqual((validated.record.body as { errors: string[] }).errors, ['Unknown package: figlett']);
});

test('without Docker, a virtual package that some package provides is accepted', async () => {
    setAgentImagePackageIndexLoader(async () => packageIndex());
    const queued: unknown[] = [];
    const put = responseRecorder();
    await remoteOnlyRoutes(queued).putRuntimePackages(adminRequest({ packages: ['mail-transport-agent', 'figlet=2.2.5-3+b1'] }), put.response);
    assert.equal(put.record.status, 202);
    assert.equal(queued.length, 1);
    assert.equal((put.record.body as { warnings?: string[] }).warnings, undefined);
});

test('without Docker, an index that cannot be fetched saves the list with a warning', async () => {
    setAgentImagePackageIndexLoader(async () => { throw new Error('getaddrinfo ENOTFOUND deb.debian.org'); });
    const queued: unknown[] = [];
    const routes = remoteOnlyRoutes(queued);
    const put = responseRecorder();
    await routes.putRuntimePackages(adminRequest({ packages: ['figlett'] }), put.response);
    assert.equal(put.record.status, 202);
    assert.equal(queued.length, 1);
    const [warning] = (put.record.body as { warnings: string[] }).warnings;
    assert.match(warning, /^could not verify availability: .*ENOTFOUND deb\.debian\.org/);

    const validated = responseRecorder();
    await routes.validateRuntimePackages(adminRequest({ packages: ['figlett'] }), validated.response);
    assert.equal(validated.record.status, 200);
    assert.match((validated.record.body as { warnings: string[] }).warnings[0], /could not verify availability/);
});

test('without Docker, a cold index download that outlasts the request still saves the list with a warning', async () => {
    const previous = process.env.PROPR_AGENT_RUNTIME_REQUEST_TIMEOUT_MS;
    process.env.PROPR_AGENT_RUNTIME_REQUEST_TIMEOUT_MS = '400';
    // The archive never answers: only the index deadline, kept under the request deadline, ends the wait.
    setAgentImagePackageIndexLoader(() => new Promise<AgentImagePackageIndex>(() => {}));
    try {
        const queued: unknown[] = [];
        const routes = remoteOnlyRoutes(queued, { remoteTargets: async () => [{ runtimes: ['Sprites'], base: DEFAULT_SPRITE_PACKAGE_BASE }] });
        const put = responseRecorder();
        await routes.putRuntimePackages(adminRequest({ packages: ['figlet'] }), put.response);
        assert.equal(put.record.status, 202);
        assert.equal(queued.length, 1, 'the list is queued for its build');
        assert.match((put.record.body as { warnings: string[] }).warnings[0], /^could not verify availability for Sprites .*not loaded within 300ms/);

        const validated = responseRecorder();
        await routes.validateRuntimePackages(adminRequest({ packages: ['figlet'] }), validated.response);
        assert.equal(validated.record.status, 200);

        const invalid = responseRecorder();
        await routes.putRuntimePackages(adminRequest({ packages: ['bad;name'] }), invalid.response);
        assert.equal(invalid.record.status, 400, 'syntax errors are still refused');
        assert.equal(queued.length, 1);
    } finally {
        if (previous === undefined) delete process.env.PROPR_AGENT_RUNTIME_REQUEST_TIMEOUT_MS;
        else process.env.PROPR_AGENT_RUNTIME_REQUEST_TIMEOUT_MS = previous;
    }
});

// A Sprite runs Ubuntu, so its names differ from the agent image's Debian ones.
const spriteIndex = () => createAgentImagePackageIndex({ figlet: ['2.2.5-3build1'], libssl3t64: ['3.5.3-1ubuntu2'] });

test('each runtime in use is checked against its own apt sources, and errors name the runtime', async () => {
    setAgentImagePackageIndexLoader(async (_signal, base) => base?.key === DEFAULT_SPRITE_PACKAGE_BASE.key ? spriteIndex() : packageIndex());
    const queued: unknown[] = [];
    const routes = remoteOnlyRoutes(queued, {
        remoteInstall: async () => 'Installed when Sprites are provisioned and in a derived Fly Machine image; no Docker image is built',
        remoteTargets: async () => [{ runtimes: ['Fly Machines'], base: AGENT_IMAGE_PACKAGE_BASE }, { runtimes: ['Sprites'], base: DEFAULT_SPRITE_PACKAGE_BASE }],
    });
    const put = responseRecorder();
    await routes.putRuntimePackages(adminRequest({ packages: ['figlet', 'libssl3t64', 'postfix'] }), put.response);
    assert.equal(put.record.status, 400);
    assert.deepEqual((put.record.body as { errors: string[] }).errors, [
        'Fly Machines (Debian 12 (bookworm)): Unknown package: libssl3t64',
        'Sprites (Ubuntu 26.04 LTS (resolute)): Unknown package: postfix',
    ]);
    assert.deepEqual(queued, []);

    // Sprites alone: the Ubuntu-only name is accepted rather than refused by the Debian index.
    const spritesOnly = remoteOnlyRoutes(queued, {
        remoteInstall: async () => 'Installed when Sprites are provisioned; no Docker image is built',
        remoteTargets: async () => [{ runtimes: ['Sprites'], base: DEFAULT_SPRITE_PACKAGE_BASE }],
    });
    const accepted = responseRecorder();
    await spritesOnly.putRuntimePackages(adminRequest({ packages: ['libssl3t64=3.5.3-1ubuntu2'] }), accepted.response);
    assert.equal(accepted.record.status, 202);
    assert.equal(queued.length, 1);
});

test('with Docker reachable and Sprites in use, Docker\'s image check and the Sprite base check both run', async () => {
    setAgentImagePackageIndexLoader(async () => spriteIndex());
    const routes = remoteOnlyRoutes([], {
        remoteInstall: async () => undefined,
        remoteTargets: async () => [{ runtimes: ['Sprites'], base: DEFAULT_SPRITE_PACKAGE_BASE }],
        validateAvailability: async packages => ({ valid: false, packages: packages as string[], errors: ['libssl3t64 is unavailable on Debian GNU/Linux 12 (bookworm)'],
            availability: [{ package: 'libssl3t64', available: false, unavailableOn: ['Debian GNU/Linux 12 (bookworm)'] }, { package: 'figlet', available: true, unavailableOn: [] }],
            sources: [] }),
    });
    const validated = responseRecorder();
    await routes.validateRuntimePackages(adminRequest({ packages: ['figlet', 'libssl3t64'] }), validated.response);
    assert.equal(validated.record.status, 400);
    assert.deepEqual((validated.record.body as { errors: string[] }).errors, ['Docker: libssl3t64 is unavailable on Debian GNU/Linux 12 (bookworm)']);
});

test('the state response recomputes appliedBy from the runtimes in use and shows each runtime\'s own state', async () => {
    const stale: AgentRuntimePackageState = {
        ...initialState(), packages: ['figlet'], activePackages: ['figlet'], status: 'ready',
        appliedBy: 'Installed when Sprites are provisioned; no Docker image is built',
        remote: { sprites: { packages: ['figlet'], status: 'ready', base: 'Ubuntu 26.04 LTS (resolute)', updatedAt: '2026-11-26T00:00:00.000Z' } },
    };
    // Docker agents were added after a remote-only period: the stored note is stale.
    const routes = remoteOnlyRoutes([], {
        loadState: async () => stale,
        runtimeUsage: async () => ({ runtimes: ['docker', 'sprites'], docker: true }),
    });
    const got = responseRecorder();
    await routes.getRuntimePackages(adminRequest(), got.response);
    const body = got.record.body as AgentRuntimePackageState & { runtimes: Array<{ runtime: string; status: string; activePackages: string[]; source: string }> };
    assert.equal(body.appliedBy, undefined, 'no "no Docker image is built" note once Docker is in use');
    assert.deepEqual(body.runtimes.map(entry => [entry.runtime, entry.status, entry.activePackages, entry.source]), [
        ['docker', 'ready', ['figlet'], 'derived Docker image'],
        ['sprites', 'ready', ['figlet'], 'Ubuntu 26.04 LTS (resolute)'],
    ]);
});
