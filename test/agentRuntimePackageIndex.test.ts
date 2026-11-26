import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { after, afterEach, test } from 'node:test';
import { closeConnection } from '../packages/core/src/db/connection.ts';
import {
    AGENT_IMAGE_APT_SOURCES, AgentRuntimePackageUnavailableError, assertAgentRuntimePackagesInIndex, fetchAgentImagePackageIndex,
    findUnavailableAgentRuntimePackages, getAgentImagePackageIndex, prevalidatedAgentRuntimePackages, setAgentImagePackageIndexLoader,
    validateAgentRuntimePackagesWithIndex, type AgentImagePackageIndex, type FetchLike,
} from '../packages/core/src/agents/runtime/agentRuntimePackageIndex.ts';
import { FlyMachinesRuntime } from '../packages/core/src/agents/runtime/flyMachinesRuntime.ts';
import { AgentRunSpecBuilder, agentRunNetwork } from '../packages/core/src/agents/runtime/agentRunSpec.ts';
import type { MachineLaunch, MachinesApi } from '../packages/core/src/agents/runtime/fly/api.ts';
import { FlyPackageImages } from '../packages/core/src/agents/runtime/fly/derivedImage.ts';
import type { RegistryApi } from '../packages/core/src/agents/runtime/fly/registry.ts';
import { SpritePool } from '../packages/core/src/agents/runtime/sprites/spritesProvisioning.ts';
import { WORKSPACE_TRANSPORT_RESULT_DIR as RESULT, WORKSPACE_TRANSPORT_SCRIPT } from '../packages/core/src/git/workspaceTransportScript.ts';
import { FakeSprites } from './helpers/fakeSprites.ts';

after(closeConnection);
afterEach(() => setAgentImagePackageIndexLoader());

const sha = (data: Buffer) => crypto.createHash('sha256').update(data).digest('hex');

const MAIN = `Package: figlet
Version: 2.2.5-3+b1
Installed-Size: 702
Depends: libc6 (>= 2.34)

Package: postfix
Version: 3.7.11-0+deb12u1
Provides: default-mta, mail-transport-agent

Package: exim4-daemon-light
Version: 4.96-15+deb12u7
Provides: mail-transport-agent,
 exim4-localscanapi-6.0 (= 6.0), libc-dev:any
`;
const SECURITY = `Package: postfix
Version: 3.7.12-0+deb12u1
Provides: default-mta, mail-transport-agent
`;

/** A Debian archive: InRelease with SHA256 entries, main as Packages.gz only, security as Packages.xz only. */
function archive(overrides: { corrupt?: boolean } = {}) {
    const files = new Map<string, Buffer>();
    const release = (entries: Array<[string, Buffer]>, listed: Array<[string, Buffer]> = []) => 'Origin: Debian\nSHA256:\n'
        + [...entries, ...listed].map(([name, data]) => ` ${sha(data)} ${String(data.length).padStart(9)} ${name}`).join('\n') + '\n';
    const mainGz = zlib.gzipSync(Buffer.from(MAIN));
    // The uncompressed form is listed but not served, like bookworm-updates.
    files.set('https://deb.debian.org/debian/dists/bookworm/InRelease', Buffer.from(release([['main/binary-amd64/Packages.gz', mainGz]],
        [['main/binary-amd64/Packages', Buffer.from(MAIN)]])));
    files.set('https://deb.debian.org/debian/dists/bookworm/main/binary-amd64/Packages.gz', overrides.corrupt ? zlib.gzipSync(Buffer.from('x')) : mainGz);
    const securityXz = Buffer.from('xz:' + SECURITY);
    files.set('https://deb.debian.org/debian-security/dists/bookworm-security/InRelease', Buffer.from(release([['main/binary-amd64/Packages.xz', securityXz]])));
    files.set('https://deb.debian.org/debian-security/dists/bookworm-security/main/binary-amd64/Packages.xz', securityXz);
    const requested: string[] = [];
    const fetcher: FetchLike = async url => {
        requested.push(url);
        const data = files.get(url);
        return { ok: Boolean(data), status: data ? 200 : 404, arrayBuffer: async () => data!.buffer.slice(data!.byteOffset, data!.byteOffset + data!.length) as ArrayBuffer };
    };
    return { fetcher, requested };
}
const sources = AGENT_IMAGE_APT_SOURCES.filter(source => source.suite !== 'bookworm-updates');
// Stands in for xz: the fixture "compresses" by prefixing.
const fakeUnxz = [async function* (data: Buffer) {
    if (!data.subarray(0, 3).equals(Buffer.from('xz:'))) throw new Error('not xz');
    yield data.subarray(3);
}];

function index(): AgentImagePackageIndex {
    return { packages: new Map([['figlet', new Set(['2.2.5-3+b1'])], ['postfix', new Set(['3.7.11-0+deb12u1'])]]),
        provides: new Set(['mail-transport-agent']), loadedAt: Date.now() };
}

test('the agent image apt sources are the bookworm suites of Dockerfile.agent', () => {
    assert.deepEqual(AGENT_IMAGE_APT_SOURCES.map(source => `${source.url} ${source.suite} ${source.component}`), [
        'https://deb.debian.org/debian bookworm main',
        'https://deb.debian.org/debian bookworm-updates main',
        'https://deb.debian.org/debian-security bookworm-security main',
    ]);
});

test('the index is read from InRelease-verified Packages files: real names, versions and provided virtual packages', async () => {
    const { fetcher, requested } = archive();
    const loaded = await fetchAgentImagePackageIndex({ fetch: fetcher, sources, unxz: fakeUnxz });
    assert.deepEqual(requested, [
        'https://deb.debian.org/debian/dists/bookworm/InRelease',
        'https://deb.debian.org/debian/dists/bookworm/main/binary-amd64/Packages.gz',
        'https://deb.debian.org/debian-security/dists/bookworm-security/InRelease',
        'https://deb.debian.org/debian-security/dists/bookworm-security/main/binary-amd64/Packages.xz',
    ]);
    assert.deepEqual([...loaded.packages.keys()].sort(), ['exim4-daemon-light', 'figlet', 'postfix']);
    assert.deepEqual([...loaded.packages.get('postfix')!].sort(), ['3.7.11-0+deb12u1', '3.7.12-0+deb12u1']);
    assert.deepEqual([...loaded.provides].sort(), ['default-mta', 'exim4-localscanapi-6.0', 'libc-dev', 'mail-transport-agent']);
    const result = findUnavailableAgentRuntimePackages(loaded, [
        'figlet', 'mail-transport-agent', 'libc-dev', 'postfix=3.7.12-0+deb12u1', 'figlet:amd64', 'figlett', 'nope', 'figlet=9',
    ]);
    assert.deepEqual(result.errors, ['Unknown package: figlett', 'Unknown package: nope', 'Unknown version: figlet=9']);
});

test('an index that does not match its InRelease checksum is not used', async () => {
    const { fetcher } = archive({ corrupt: true });
    await assert.rejects(fetchAgentImagePackageIndex({ fetch: fetcher, sources, unxz: fakeUnxz }), /No usable main\/binary-amd64\/Packages index/);
});

test('without an xz decoder a suite that only publishes Packages.xz cannot be read', async () => {
    const { fetcher } = archive();
    await assert.rejects(fetchAgentImagePackageIndex({ fetch: fetcher, sources, unxz: [] }), /bookworm-security/);
});

test('the index is cached: concurrent and later callers share one download, and a failure is replayed without the network', async () => {
    let loads = 0;
    setAgentImagePackageIndexLoader(async () => { loads++; return index(); });
    await Promise.all([getAgentImagePackageIndex(), getAgentImagePackageIndex()]);
    await getAgentImagePackageIndex();
    assert.equal(loads, 1);

    let failures = 0;
    setAgentImagePackageIndexLoader(async () => { failures++; throw new Error('offline'); });
    await assert.rejects(getAgentImagePackageIndex(), /offline/);
    await assert.rejects(getAgentImagePackageIndex(), /offline/);
    assert.equal(failures, 1);
});

test('Settings validation lists every unknown name, accepts a virtual package and passes with a warning when the index is unavailable', async () => {
    setAgentImagePackageIndexLoader(async () => index());
    const rejected = await validateAgentRuntimePackagesWithIndex(['figlett', 'mail-transport-agent', 'nope']);
    assert.equal(rejected.valid, false);
    assert.deepEqual(rejected.errors, ['Unknown package: figlett', 'Unknown package: nope']);
    assert.deepEqual(rejected.warnings, []);
    assert.equal((await validateAgentRuntimePackagesWithIndex(['mail-transport-agent'])).valid, true);
    assert.equal((await validateAgentRuntimePackagesWithIndex(['bad;name'])).valid, false, 'syntax errors still fail');

    setAgentImagePackageIndexLoader(async () => { throw new Error('getaddrinfo ENOTFOUND deb.debian.org'); });
    const unverified = await validateAgentRuntimePackagesWithIndex(['figlett']);
    assert.equal(unverified.valid, true);
    assert.match(unverified.warnings[0], /^could not verify availability: .*ENOTFOUND/);
    // Before a build: an unavailable index lets the run go ahead.
    await assertAgentRuntimePackagesInIndex(['figlett']);
});

test('the runtime package source refuses a list the index rejects', async () => {
    setAgentImagePackageIndexLoader(async () => index());
    const source = prevalidatedAgentRuntimePackages(async () => ['figlet', 'figlett']);
    await assert.rejects(source(), (error: unknown) => {
        assert.ok(error instanceof AgentRuntimePackageUnavailableError);
        assert.deepEqual(error.unknown, ['figlett']);
        assert.match(error.message, /Unknown package: figlett\. The run was not started/);
        return true;
    });
    assert.deepEqual(await prevalidatedAgentRuntimePackages(async () => ['figlet'])(), ['figlet']);
    let loads = 0;
    setAgentImagePackageIndexLoader(async () => { loads++; return index(); });
    assert.deepEqual(await prevalidatedAgentRuntimePackages(async () => [])(), []);
    assert.equal(loads, 0, 'no packages, no index read');
});

test('a Fly run whose list the index rejects never starts a build or agent Machine', async () => {
    setAgentImagePackageIndexLoader(async () => index());
    const launches: MachineLaunch[] = [];
    let registryCalls = 0;
    const api = {
        create: async (launch: MachineLaunch) => { launches.push(launch); return 'm0'; },
        exec: async () => ({ stdout: '', exit_code: 1 }), logs: async () => {}, signal: async () => {},
        destroy: async () => {}, gone: async () => true,
    } as unknown as MachinesApi;
    const registry = new Proxy({}, { get: () => async () => { registryCalls++; throw new Error('unexpected registry call'); } }) as RegistryApi;
    const fly = new FlyMachinesRuntime(api, { PROPR_FLY_APP: 'index', PROPR_FLY_API_TOKEN: 'FlyV1 synthetic', PROPR_FLY_IMAGE: 'registry.fly.io/agents:current' },
        prevalidatedAgentRuntimePackages(async () => ['figlett']), new FlyPackageImages(() => registry));
    const spec = new AgentRunSpecBuilder({
        agentType: 'claude', image: 'propr/agent', name: 'task', stdin: true, user: '0:0', network: agentRunNetwork('bridge'),
        workspace: { hostPath: '/unused', containerPath: '/home/node/workspace', readOnly: false, mode: 'clone',
            clone: { remote: 'unused', baseRef: 'base', baseCommit: '0123', branch: 'test', resultDir: RESULT, script: WORKSPACE_TRANSPORT_SCRIPT } },
    }).command('claude', '--version').build();
    const run = fly.start(spec);
    await assert.rejects(run.wait(), /Unknown package: figlett/);
    assert.deepEqual(launches, [], 'no build Machine and no agent Machine');
    assert.equal(registryCalls, 0, 'the base image is not even resolved');
});

test('a Sprite is never created for a list the index rejects', async () => {
    setAgentImagePackageIndexLoader(async () => index());
    const client = new FakeSprites();
    const pool = new SpritePool(client, undefined, prevalidatedAgentRuntimePackages(async () => ['figlett']));
    await assert.rejects(pool.acquire(new AbortController().signal), /Unknown package: figlett/);
    assert.deepEqual(client.created, []);
    await pool.close();
});
