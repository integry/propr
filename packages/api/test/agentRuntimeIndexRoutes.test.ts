import assert from 'node:assert/strict';
import { after, afterEach, test } from 'node:test';
import type { Request, Response } from 'express';
import { createAgentRuntimeRoutes } from '../routes/agentRuntimeRoutes.js';
import {
    closeConnection,
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

const packageIndex = (): AgentImagePackageIndex => ({
    packages: new Map([
        ['postgresql-client', new Set(['15+248'])],
        ['figlet', new Set(['2.2.5-3+b1'])],
        ['postfix', new Set(['3.7.11-0+deb12u1'])]
    ]),
    provides: new Set(['mail-transport-agent', 'default-mta']),
    loadedAt: Date.now()
});

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

function remoteOnlyRoutes(queued: unknown[]) {
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
            validateWithIndex: validateAgentRuntimePackagesWithIndex
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
