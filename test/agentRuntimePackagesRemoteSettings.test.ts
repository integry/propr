import assert from 'node:assert/strict';
import crypto from 'node:crypto';
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
let index: typeof import('../packages/core/src/agents/runtime/agentRuntimePackageIndex.js');
let remotePackages: typeof import('../packages/core/src/agents/runtime/agentRuntimeRemotePackages.js');
let bases: typeof import('../packages/core/src/agents/runtime/agentRuntimePackageBases.js');

before(async () => {
    packages = await import('../packages/core/src/agents/runtime/agentRuntimePackages.js');
    profile = await import('../packages/core/src/agents/runtime/agentRuntimePackageProfile.js');
    connection = await import('../packages/core/src/db/connection.js');
    index = await import('../packages/core/src/agents/runtime/agentRuntimePackageIndex.js');
    remotePackages = await import('../packages/core/src/agents/runtime/agentRuntimeRemotePackages.js');
    bases = await import('../packages/core/src/agents/runtime/agentRuntimePackageBases.js');
    await connection.runMigrations();
    // Debian (agent image) and Ubuntu (Sprite base) indexes that differ in one name each.
    index.setAgentImagePackageIndexLoader(async (_signal, base) => base!.key === bases.DEFAULT_SPRITE_PACKAGE_BASE.key
        ? index.createAgentImagePackageIndex({ jq: ['1.8.1-3'], 'postgresql-client': ['18'], libssl3t64: ['3.5.3-1ubuntu2'] })
        : index.createAgentImagePackageIndex({ jq: ['1.6-2.1'], 'postgresql-client': ['15'], postfix: ['3.7.11-0+deb12u1'] }));
});

const fly = { runtimes: ['fly-machines'], docker: false };
const sprites = { runtimes: ['sprites'], docker: false };
const mixed = { runtimes: ['docker', 'sprites'], docker: true };

after(async () => {
    index.setAgentImagePackageIndexLoader();
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

test('the API follows the runtime the worker published when its own environment selects none', async () => {
    const install = profile.remoteAgentRuntimePackageInstall;
    const published = async () => 'fly-machines';
    assert.equal(await install([], {}, { published }), 'Installed in a derived Fly Machine image; no Docker image is built');
    assert.equal(await install([{ runtime: 'docker' }], {}, { published }), undefined, 'an agent pinned to Docker still builds the image');
    assert.equal(await install([], { PROPR_AGENT_RUNTIME: 'docker' }, { published }), undefined, 'this process\'s own setting wins');
    assert.equal(await install([], {}, { published: async () => { throw new Error('db down'); } }), undefined);
    assert.equal(await profile.remoteAgentRuntimeConfigured([{ runtime: 'docker' }], {}, { published }), true);
    assert.equal(await profile.remoteAgentRuntimeConfigured([{ runtime: 'docker' }], {}, { published: async () => 'docker' }), false);
    assert.equal(await profile.remoteAgentRuntimeConfigured([{ runtime: 'sprites', enabled: true }], {}, { published: async () => undefined }), true);

    // Published through the shared config store by the worker, read back by the default reader.
    await profile.publishWorkerAgentRuntime({ PROPR_AGENT_RUNTIME: 'sprites' });
    assert.equal(await install([], {}), 'Installed when Sprites are provisioned; no Docker image is built');
    await profile.publishWorkerAgentRuntime({});
    assert.equal(await install([], {}), undefined);
});

test('without Docker the package build validates the list and reports it applied by the remote runtime, not failed', async () => {
    const usage = async () => fly;
    const job = await packages.requestAgentRuntimePackageBuild(['postgresql-client', 'jq'], [BASE_IMAGE]);
    const state = await packages.buildAgentRuntimePackageProfile(job, { usage });
    assert.equal(state.status, 'ready');
    assert.deepEqual(state.activePackages, ['jq', 'postgresql-client']);
    assert.deepEqual(state.images, {});
    assert.equal(state.error, undefined);
    assert.equal(state.appliedBy, 'Installed in a derived Fly Machine image; no Docker image is built');
    assert.deepEqual(state.remote?.['fly-machines']?.packages, ['jq', 'postgresql-client']);
    const stored = await packages.loadAgentRuntimePackageState();
    assert.equal(stored.status, 'ready');
    assert.equal(stored.appliedBy, state.appliedBy);

    // Clearing the list disables the profile, again without touching Docker.
    const cleared = await packages.buildAgentRuntimePackageProfile(
        await packages.requestAgentRuntimePackageBuild([], [BASE_IMAGE]), { usage });
    assert.equal(cleared.status, 'disabled');
    assert.equal(cleared.appliedBy, undefined);
    assert.deepEqual(await remotePackages.loadAcceptedRemoteAgentRuntimePackages('fly-machines'), []);
});

test('clearing the list empties every remote runtime\'s record, including runtimes not in use now', async () => {
    await packages.buildAgentRuntimePackageProfile(await packages.requestAgentRuntimePackageBuild(['jq'], [BASE_IMAGE]), { usage: async () => sprites });
    assert.deepEqual(await remotePackages.loadAcceptedRemoteAgentRuntimePackages('sprites'), ['jq']);

    // The agents move to Fly Machines, then the list is cleared: Sprites take no part in that build.
    const cleared = await packages.buildAgentRuntimePackageProfile(
        await packages.requestAgentRuntimePackageBuild([], [BASE_IMAGE]), { usage: async () => fly });
    assert.equal(cleared.status, 'disabled');
    assert.equal(cleared.remote, undefined);
    assert.deepEqual(await remotePackages.loadAcceptedRemoteAgentRuntimePackages('fly-machines'), []);
    // Selecting Sprites again does not bring the cleared packages back.
    assert.deepEqual(await remotePackages.loadAcceptedRemoteAgentRuntimePackages('sprites'), []);
    const view = remotePackages.describeAgentRuntimePackageRuntimes(await packages.loadAgentRuntimePackageState(), sprites);
    assert.deepEqual(view.map(entry => [entry.runtime, entry.status, entry.activePackages]), [['sprites', 'disabled', []]]);
});

test('the remote path uses the same validator: an invalid list is rejected before anything is applied', async () => {
    const job = await packages.requestAgentRuntimePackageBuild(['jq'], [BASE_IMAGE]);
    await assert.rejects(packages.buildAgentRuntimePackageProfile({ ...job, packages: ['bad;rm -rf /'] }, { usage: async () => sprites }),
        /invalid package spec: bad;rm -rf \//);
});

test('remote runtimes install only their accepted list: a pending change and a refused one leave the previous list', async () => {
    const usage = async () => sprites;
    await packages.buildAgentRuntimePackageProfile(await packages.requestAgentRuntimePackageBuild(['jq'], [BASE_IMAGE]), { usage });
    assert.deepEqual(await remotePackages.loadAcceptedRemoteAgentRuntimePackages('sprites'), ['jq']);

    // Apply was clicked, the build has not run: Sprites keep installing the accepted list.
    const pendingJob = await packages.requestAgentRuntimePackageBuild(['jq', 'libssl3t64'], [BASE_IMAGE]);
    assert.equal((await packages.loadAgentRuntimePackageState()).status, 'pending');
    assert.deepEqual(await remotePackages.loadAcceptedRemoteAgentRuntimePackages('sprites'), ['jq']);
    const pendingView = remotePackages.describeAgentRuntimePackageRuntimes(await packages.loadAgentRuntimePackageState(), sprites);
    assert.deepEqual(pendingView.map(entry => [entry.runtime, entry.status, entry.activePackages]), [['sprites', 'pending', ['jq']]]);

    // The Ubuntu-only name passes the Sprite base check (it would fail against the agent image's Debian index).
    const accepted = await packages.buildAgentRuntimePackageProfile(pendingJob, { usage });
    assert.equal(accepted.status, 'ready');
    assert.deepEqual(await remotePackages.loadAcceptedRemoteAgentRuntimePackages('sprites'), ['jq', 'libssl3t64']);
    assert.equal(accepted.remote?.sprites?.base, 'Ubuntu 26.04 LTS (resolute)');

    // A name the Sprite base lacks is refused for Sprites, which keep the accepted list.
    const refused = await packages.buildAgentRuntimePackageProfile(await packages.requestAgentRuntimePackageBuild(['jq', 'postfix'], [BASE_IMAGE]), { usage });
    assert.equal(refused.status, 'failed');
    assert.match(refused.error ?? '', /^Sprites \(Ubuntu 26\.04 LTS \(resolute\)\): Unknown package: postfix$/);
    assert.deepEqual(refused.activePackages, ['jq', 'libssl3t64']);
    assert.deepEqual(await remotePackages.loadAcceptedRemoteAgentRuntimePackages('sprites'), ['jq', 'libssl3t64']);
    const view = remotePackages.describeAgentRuntimePackageRuntimes(refused, sprites);
    assert.equal(view[0].status, 'failed');
    assert.match(view[0].error ?? '', /Unknown package: postfix/);
});

test('on a mixed instance a failed Docker build leaves Docker on its list while Sprites accept theirs; Settings shows both', async () => {
    const job = await packages.requestAgentRuntimePackageBuild(['jq', 'postgresql-client'], [BASE_IMAGE]);
    await assert.rejects(packages.buildAgentRuntimePackageProfile(job, { usage: async () => mixed }));
    const failed = await packages.loadAgentRuntimePackageState();
    assert.equal(failed.status, 'failed');
    assert.deepEqual(await remotePackages.loadAcceptedRemoteAgentRuntimePackages('sprites'), ['jq', 'postgresql-client']);
    const view = remotePackages.describeAgentRuntimePackageRuntimes(failed, mixed);
    assert.deepEqual(view.map(entry => [entry.runtime, entry.status, entry.activePackages]), [
        ['docker', 'failed', failed.activePackages],
        ['sprites', 'ready', ['jq', 'postgresql-client']],
    ]);
});

test('state saved before runtimes kept their own lists falls back to the applied list, never the desired one', async () => {
    const { saveConfig } = await import('../packages/core/src/config/configStore.js');
    await saveConfig('agent_runtime_packages', { installationId: 'legacy', packages: ['jq', 'postfix'], activePackages: ['jq'], status: 'pending', images: {} });
    assert.deepEqual(await remotePackages.loadAcceptedRemoteAgentRuntimePackages('fly-machines'), ['jq']);
    assert.deepEqual(await remotePackages.loadAcceptedRemoteAgentRuntimePackages('sprites'), ['jq']);
});

test('with a Docker runtime in use the build still runs the Docker image build', async () => {
    const job = await packages.requestAgentRuntimePackageBuild(['jq'], [BASE_IMAGE]);
    await assert.rejects(packages.buildAgentRuntimePackageProfile(job, { usage: async () => ({ runtimes: ['docker'], docker: true }) }));
    const failed = await packages.loadAgentRuntimePackageState();
    assert.equal(failed.status, 'failed');
});

test('a runtime not in use when a list is applied picks up that list, checked against its own index, once selected again', async () => {
    await packages.buildAgentRuntimePackageProfile(await packages.requestAgentRuntimePackageBuild(['jq'], [BASE_IMAGE]), { usage: async () => sprites });
    assert.deepEqual(await remotePackages.loadAcceptedRemoteAgentRuntimePackages('sprites'), ['jq']);

    // The agents move to Fly Machines only, and a new list is applied there.
    const applied = await packages.buildAgentRuntimePackageProfile(
        await packages.requestAgentRuntimePackageBuild(['postgresql-client'], [BASE_IMAGE]), { usage: async () => fly });
    assert.equal(applied.status, 'ready');
    assert.deepEqual(Object.keys(applied.remote ?? {}), ['fly-machines']);

    // A Sprites agent is enabled again: it installs the applied list, not the obsolete one.
    assert.deepEqual(await remotePackages.loadAcceptedRemoteAgentRuntimePackages('sprites'), ['postgresql-client']);
    const view = remotePackages.describeAgentRuntimePackageRuntimes(await packages.loadAgentRuntimePackageState(), sprites);
    assert.deepEqual(view.map(entry => [entry.runtime, entry.status, entry.activePackages]), [['sprites', 'ready', ['postgresql-client']]]);
    await index.checkAgentRuntimePackagesBeforeInstall(remotePackages.remoteRuntimePackageSource('sprites'), ['postgresql-client']);

    // A list applied without Sprites that their base lacks fails their install check; the old list is not swapped in.
    await packages.buildAgentRuntimePackageProfile(await packages.requestAgentRuntimePackageBuild(['jq'], [BASE_IMAGE]), { usage: async () => sprites });
    await packages.buildAgentRuntimePackageProfile(await packages.requestAgentRuntimePackageBuild(['postfix'], [BASE_IMAGE]), { usage: async () => fly })
        .catch(() => undefined);
    const flyApplied = await packages.loadAgentRuntimePackageState();
    // Fly's Debian index has postfix, so the Fly-only build applies it and supersedes the Sprites record.
    assert.equal(flyApplied.status, 'ready');
    const source = remotePackages.remoteRuntimePackageSource('sprites');
    assert.deepEqual(await source(), ['postfix']);
    await assert.rejects(index.checkAgentRuntimePackagesBeforeInstall(source, await source()), /postfix/);
});

test('a refused or pending change keeps the records of runtimes not in use', async () => {
    await packages.buildAgentRuntimePackageProfile(await packages.requestAgentRuntimePackageBuild(['jq'], [BASE_IMAGE]), { usage: async () => sprites });
    // Fly's Debian index lacks libssl3t64, so the Fly-only build is refused and applies nothing.
    const refused = await packages.buildAgentRuntimePackageProfile(
        await packages.requestAgentRuntimePackageBuild(['libssl3t64'], [BASE_IMAGE]), { usage: async () => fly });
    assert.equal(refused.status, 'failed');
    assert.deepEqual(await remotePackages.loadAcceptedRemoteAgentRuntimePackages('sprites'), ['jq']);
    await packages.requestAgentRuntimePackageBuild(['postgresql-client'], [BASE_IMAGE]);
    assert.deepEqual(await remotePackages.loadAcceptedRemoteAgentRuntimePackages('sprites'), ['jq']);
});

// A Settings request B saved while remote-only build A is between its index checks and its outcome
// write. B is written on a second connection the moment A's outcome write is issued (A's "building"
// save is skipped), the latest point a concurrent request can land before A's write runs.
for (const [label, requestA] of [['an applied list', ['jq']], ['a cleared list', []]] as const) {
    test(`a newer Settings request saved before a remote-only build writes ${label} is kept, and its own build applies`, async () => {
        const usage = async () => sprites;
        await packages.buildAgentRuntimePackageProfile(await packages.requestAgentRuntimePackageBuild(['postgresql-client'], [BASE_IMAGE]), { usage });
        const jobA = await packages.requestAgentRuntimePackageBuild([...requestA], [BASE_IMAGE]);
        const { default: Database } = await import('better-sqlite3');
        const config = connection.db.client.config as { connection: { filename: string } };
        const settings = new Database(config.connection.filename);
        let jobB: Awaited<ReturnType<typeof packages.requestAgentRuntimePackageBuild>> | undefined;
        const onQuery = (query: { sql: string; bindings?: unknown[] }) => {
            if (jobB || !/^(insert|update)\b/i.test(query.sql) || !query.sql.includes('system_configs')) return;
            const value = query.bindings?.find((binding): binding is string => typeof binding === 'string' && binding.includes(jobA.buildId));
            if (!value || JSON.parse(value).status === 'building') return;
            // What `requestAgentRuntimePackageBuild` writes for B.
            const row = settings.prepare('SELECT value FROM system_configs WHERE key = ?').get('agent_runtime_packages') as { value: string };
            const pending = { ...JSON.parse(row.value), packages: ['jq', 'libssl3t64'], status: 'pending', buildId: crypto.randomUUID(),
                error: undefined, buildLog: undefined, updatedAt: new Date().toISOString() };
            settings.prepare('UPDATE system_configs SET value = ? WHERE key = ?').run(JSON.stringify(pending), 'agent_runtime_packages');
            jobB = { buildId: pending.buildId, installationId: pending.installationId, packages: pending.packages, baseImages: [BASE_IMAGE] };
        };
        connection.db.on('query', onQuery);
        let superseded;
        try {
            superseded = await packages.buildAgentRuntimePackageProfile(jobA, { usage });
        } finally {
            connection.db.off('query', onQuery);
            settings.close();
        }
        assert.ok(jobB, 'build A issued its outcome write');
        assert.equal(superseded.buildId, jobB.buildId, 'build A returns the newer state');
        const pending = await packages.loadAgentRuntimePackageState();
        assert.equal(pending.buildId, jobB.buildId);
        assert.equal(pending.status, 'pending');
        assert.deepEqual(pending.packages, ['jq', 'libssl3t64']);
        assert.deepEqual(pending.activePackages, ['postgresql-client'], 'build A activated nothing');
        assert.deepEqual(await remotePackages.loadAcceptedRemoteAgentRuntimePackages('sprites'), ['postgresql-client']);

        const applied = await packages.buildAgentRuntimePackageProfile(jobB, { usage });
        assert.equal(applied.status, 'ready');
        assert.deepEqual(applied.activePackages, ['jq', 'libssl3t64']);
        assert.deepEqual(await remotePackages.loadAcceptedRemoteAgentRuntimePackages('sprites'), ['jq', 'libssl3t64']);
    });
}
