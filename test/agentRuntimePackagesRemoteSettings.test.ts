import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

// The Settings package build on a worker that runs only remote runtimes. The
// base image below does not exist, so any Docker build or inspection would fail
// the build: a `ready` state shows none ran.
const BASE_IMAGE = 'propr/agent:remote-only-test-missing';
const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'propr-runtime-packages-remote-'));
process.env.DATA_DIR = testDataDir;

let packages: typeof import('../packages/core/src/agents/runtime/agentRuntimePackages.js');
let profile: typeof import('../packages/core/src/agents/runtime/agentRuntimePackageProfile.js');
let connection: typeof import('../packages/core/src/db/connection.js');

before(async () => {
    packages = await import('../packages/core/src/agents/runtime/agentRuntimePackages.js');
    profile = await import('../packages/core/src/agents/runtime/agentRuntimePackageProfile.js');
    connection = await import('../packages/core/src/db/connection.js');
    await connection.runMigrations();
});

after(async () => {
    await connection.closeConnection();
    fs.rmSync(testDataDir, { recursive: true, force: true });
});

test('remote-only selections report how the packages are installed; any Docker agent keeps the image build', async () => {
    const install = profile.remoteAgentRuntimePackageInstall;
    assert.equal(await install([{ runtime: 'docker' }], {}), undefined);
    assert.equal(await install([{ runtime: 'sprites' }, {}], {}), undefined, 'an agent on the default runtime uses Docker');
    assert.equal(await install([{ runtime: 'sprites' }], {}), 'Installed when Sprites are provisioned; no Docker image is built');
    assert.equal(await install([], { PROPR_AGENT_RUNTIME: 'fly-machines' }), 'Installed in a derived Fly Machine image; no Docker image is built');
    assert.equal(await install([{ runtime: 'fly-machines' }, { runtime: 'sprites' }, { runtime: 'docker', enabled: false }], {}),
        'Installed when Sprites are provisioned and in a derived Fly Machine image; no Docker image is built');
});

test('without Docker the package build validates the list and reports it applied by the remote runtime, not failed', async () => {
    const remoteInstall = async () => 'Installed in a derived Fly Machine image; no Docker image is built';
    const job = await packages.requestAgentRuntimePackageBuild(['postgresql-client', 'jq'], [BASE_IMAGE]);
    const state = await packages.buildAgentRuntimePackageProfile(job, { remoteInstall });
    assert.equal(state.status, 'ready');
    assert.deepEqual(state.activePackages, ['jq', 'postgresql-client']);
    assert.deepEqual(state.images, {});
    assert.equal(state.error, undefined);
    assert.equal(state.appliedBy, 'Installed in a derived Fly Machine image; no Docker image is built');
    const stored = await packages.loadAgentRuntimePackageState();
    assert.equal(stored.status, 'ready');
    assert.equal(stored.appliedBy, state.appliedBy);

    // Clearing the list disables the profile, again without touching Docker.
    const cleared = await packages.buildAgentRuntimePackageProfile(
        await packages.requestAgentRuntimePackageBuild([], [BASE_IMAGE]), { remoteInstall });
    assert.equal(cleared.status, 'disabled');
    assert.equal(cleared.appliedBy, undefined);
});

test('the remote path uses the same validator: an invalid list is rejected before anything is applied', async () => {
    const job = await packages.requestAgentRuntimePackageBuild(['jq'], [BASE_IMAGE]);
    await assert.rejects(packages.buildAgentRuntimePackageProfile({ ...job, packages: ['bad;rm -rf /'] }, { remoteInstall: async () => 'Installed when Sprites are provisioned' }),
        /invalid package spec: bad;rm -rf \//);
});

test('with a Docker runtime in use the build still runs the Docker image build', async () => {
    const job = await packages.requestAgentRuntimePackageBuild(['jq'], [BASE_IMAGE]);
    await assert.rejects(packages.buildAgentRuntimePackageProfile(job, { remoteInstall: async () => undefined }));
    const failed = await packages.loadAgentRuntimePackageState();
    assert.equal(failed.status, 'failed');
});
