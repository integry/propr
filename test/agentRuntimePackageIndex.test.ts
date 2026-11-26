import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import zlib from 'node:zlib';
import { after, afterEach, test } from 'node:test';
import { closeConnection } from '../packages/core/src/db/connection.ts';
import {
    AGENT_IMAGE_APT_SOURCES, AgentRuntimePackageUnavailableError, assertAgentRuntimePackagesInIndex, createAgentImagePackageIndex, fetchAgentImagePackageIndex,
    findUnavailableAgentRuntimePackages, getAgentImagePackageIndex, indexCheckedAgentRuntimePackages, setAgentImagePackageIndexLoader,
    validateAgentRuntimePackagesWithIndex, type AgentImagePackageIndex, type FetchLike,
} from '../packages/core/src/agents/runtime/agentRuntimePackageIndex.ts';
import { AGENT_IMAGE_PACKAGE_BASE, DEFAULT_SPRITE_PACKAGE_BASE, parseOneLineAptSources } from '../packages/core/src/agents/runtime/agentRuntimePackageBases.ts';
import { FlyMachinesRuntime } from '../packages/core/src/agents/runtime/flyMachinesRuntime.ts';
import { AgentRunSpecBuilder, agentRunNetwork } from '../packages/core/src/agents/runtime/agentRunSpec.ts';
import type { MachineLaunch, MachinesApi } from '../packages/core/src/agents/runtime/fly/api.ts';
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
const GH = `Package: gh
Version: 2.83.1
Architecture: amd64
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
    // GitHub's apt repository publishes plain and gzip Packages only.
    files.set('https://cli.github.com/packages/dists/stable/InRelease', Buffer.from(release([['main/binary-amd64/Packages', Buffer.from(GH)]])));
    files.set('https://cli.github.com/packages/dists/stable/main/binary-amd64/Packages', Buffer.from(GH));
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
    return createAgentImagePackageIndex({ figlet: ['2.2.5-3+b1'], postfix: ['3.7.11-0+deb12u1'] }, ['mail-transport-agent']);
}

/** Every apt source Dockerfile.agent's agent image has: its Debian base's suites plus each `deb` line it writes. */
function dockerfileAgentSources() {
    const dockerfile = readFileSync(new URL('../Dockerfile.agent', import.meta.url), 'utf8');
    const from = /^FROM\s+\S*\s*node:\$\{AGENT_NODE_VERSION\}-(\w+)-slim AS agent-base$/m.exec(dockerfile.replace(/--platform=\S+\s+/g, ''));
    assert.ok(from, 'Dockerfile.agent builds on a node:<version>-<debian>-slim base');
    const codename = from[1];
    const base = [
        `https://deb.debian.org/debian ${codename} main`,
        `https://deb.debian.org/debian ${codename}-updates main`,
        `https://deb.debian.org/debian-security ${codename}-security main`,
    ];
    const added = [...dockerfile.matchAll(/echo\s+"(deb\s[^"]+)"\s*>+\s*\/etc\/apt\/sources\.list(?:\.d\/\S+)?/g)]
        .flatMap(match => parseOneLineAptSources(match[1].replace(/\$\([^)]*\)/g, 'amd64')))
        .map(source => `${source.url} ${source.suite} ${source.component}`);
    assert.ok(added.length > 0, 'Dockerfile.agent adds GitHub\'s apt repository for gh');
    return { codename, sources: [...base, ...added] };
}

test('the agent image apt sources are exactly the ones Dockerfile.agent has, including the repositories it adds', () => {
    const { codename, sources: expected } = dockerfileAgentSources();
    assert.equal(codename, 'bookworm');
    assert.deepEqual(AGENT_IMAGE_APT_SOURCES.map(source => `${source.url} ${source.suite} ${source.component}`), expected);
    assert.ok(expected.includes('https://cli.github.com/packages stable main'));
    assert.equal(AGENT_IMAGE_PACKAGE_BASE.sources, AGENT_IMAGE_APT_SOURCES);
});

test('the index is read from InRelease-verified Packages files: real names, versions and provided virtual packages', async () => {
    const { fetcher, requested } = archive();
    const loaded = await fetchAgentImagePackageIndex({ fetch: fetcher, sources, unxz: fakeUnxz });
    assert.deepEqual(requested, [
        'https://deb.debian.org/debian/dists/bookworm/InRelease',
        'https://deb.debian.org/debian/dists/bookworm/main/binary-amd64/Packages.gz',
        'https://deb.debian.org/debian-security/dists/bookworm-security/InRelease',
        'https://deb.debian.org/debian-security/dists/bookworm-security/main/binary-amd64/Packages.xz',
        'https://cli.github.com/packages/dists/stable/InRelease',
        'https://cli.github.com/packages/dists/stable/main/binary-amd64/Packages',
    ]);
    // Compact: names (real and provided) and name=version pins, nothing else of the stanzas.
    assert.deepEqual([...loaded.names].sort(), ['default-mta', 'exim4-daemon-light', 'exim4-localscanapi-6.0', 'figlet', 'gh', 'libc-dev', 'mail-transport-agent', 'postfix']);
    assert.deepEqual([...loaded.pins].sort(), ['exim4-daemon-light=4.96-15+deb12u7', 'figlet=2.2.5-3+b1', 'gh=2.83.1', 'postfix=3.7.11-0+deb12u1', 'postfix=3.7.12-0+deb12u1']);
    const result = findUnavailableAgentRuntimePackages(loaded, [
        'figlet', 'mail-transport-agent', 'libc-dev', 'postfix=3.7.12-0+deb12u1', 'figlet:amd64', 'gh', 'gh=2.83.1', 'figlett', 'nope', 'figlet=9',
        'mail-transport-agent=1',
    ]);
    assert.deepEqual(result.errors, ['Unknown package: figlett', 'Unknown package: nope', 'Unknown version: figlet=9', 'Unknown version: mail-transport-agent=1']);
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

test('each package base has its own cached index; a caller that gives up does not cancel the shared download', async () => {
    const loaded: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    setAgentImagePackageIndexLoader(async (_signal, base) => { loaded.push(base!.label); await gate; return index(); });
    const controller = new AbortController();
    const abandoned = getAgentImagePackageIndex(controller.signal, DEFAULT_SPRITE_PACKAGE_BASE);
    controller.abort(new Error('caller gave up'));
    await assert.rejects(abandoned, /caller gave up/);
    const waiting = getAgentImagePackageIndex(undefined, DEFAULT_SPRITE_PACKAGE_BASE);
    const agentImage = getAgentImagePackageIndex();
    release();
    await Promise.all([waiting, agentImage]);
    assert.deepEqual(loaded, [DEFAULT_SPRITE_PACKAGE_BASE.label, AGENT_IMAGE_PACKAGE_BASE.label], 'one download per base, shared after the abort');
});

test('Settings checks each runtime against its own base, naming the runtime in every error', async () => {
    // A Sprite (Ubuntu 26.04) has t64 library names and Ubuntu pins; the agent image (bookworm) has neither.
    setAgentImagePackageIndexLoader(async (_signal, base) => base!.key === DEFAULT_SPRITE_PACKAGE_BASE.key
        ? createAgentImagePackageIndex({ figlet: ['2.2.5-3build1'], libssl3t64: ['3.5.3-1ubuntu2'] })
        : index());
    const targets = [
        { runtimes: ['Docker'], base: AGENT_IMAGE_PACKAGE_BASE },
        { runtimes: ['Sprites'], base: DEFAULT_SPRITE_PACKAGE_BASE },
        { runtimes: ['Fly Machines'], base: AGENT_IMAGE_PACKAGE_BASE },
    ];
    const result = await validateAgentRuntimePackagesWithIndex(['figlet', 'libssl3t64', 'postfix'], undefined, targets);
    assert.equal(result.valid, false);
    assert.deepEqual(result.errors, [
        'Docker and Fly Machines (Debian 12 (bookworm)): Unknown package: libssl3t64',
        'Sprites (Ubuntu 26.04 LTS (resolute)): Unknown package: postfix',
    ]);
    assert.deepEqual(result.availability.find(entry => entry.package === 'figlet')?.unavailableOn, []);
    const spritesOnly = await validateAgentRuntimePackagesWithIndex(['libssl3t64=3.5.3-1ubuntu2'], undefined, [targets[1]]);
    assert.equal(spritesOnly.valid, true, 'an Ubuntu-only name and pin pass for Sprites');
    await assert.rejects(assertAgentRuntimePackagesInIndex(['postfix'], undefined, DEFAULT_SPRITE_PACKAGE_BASE, 'Sprites'),
        /not available to Sprites from the Ubuntu 26\.04 LTS \(resolute\) apt sources .*Unknown package: postfix/);
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

test('a caller deadline turns a stalled index download into the availability warning; cancelling still rejects', async () => {
    let release!: (value: AgentImagePackageIndex) => void;
    const held = new Promise<AgentImagePackageIndex>(resolve => { release = resolve; });
    setAgentImagePackageIndexLoader(() => held);
    const targets = [{ runtimes: ['Sprites'], base: DEFAULT_SPRITE_PACKAGE_BASE }];
    const unverified = await validateAgentRuntimePackagesWithIndex(['figlett'], undefined, targets, { deadlineMs: 50 });
    assert.equal(unverified.valid, true, 'a valid list is not held up by a cold download');
    assert.match(unverified.warnings[0], /^could not verify availability for Sprites \(Ubuntu 26\.04 LTS \(resolute\)\): .*not loaded within 50ms/);
    assert.equal((await validateAgentRuntimePackagesWithIndex(['bad;name'], undefined, targets, { deadlineMs: 50 })).valid, false, 'syntax errors still fail');
    const cancel = new AbortController();
    const cancelled = validateAgentRuntimePackagesWithIndex(['figlet'], cancel.signal, targets, { deadlineMs: 10_000 });
    cancel.abort(new Error('client went away'));
    await assert.rejects(cancelled, /client went away/);

    // The download kept going: once it lands, later checks use it.
    release(index());
    await held;
    const checked = await validateAgentRuntimePackagesWithIndex(['figlett'], undefined, targets, { deadlineMs: 50 });
    assert.deepEqual(checked.errors, ['Sprites (Ubuntu 26.04 LTS (resolute)): Unknown package: figlett']);

    // A refresh that stalls past the deadline falls back to the previous index, as a failed one does.
    let loads = 0;
    setAgentImagePackageIndexLoader(() => loads++ === 0 ? Promise.resolve(index()) : new Promise<AgentImagePackageIndex>(() => {}));
    await getAgentImagePackageIndex(undefined, DEFAULT_SPRITE_PACKAGE_BASE);
    const realNow = Date.now;
    const later = realNow() + 5 * 60 * 60_000;
    Date.now = () => later;
    try {
        const stale = await validateAgentRuntimePackagesWithIndex(['figlett'], undefined, targets, { deadlineMs: 50 });
        assert.equal(loads, 2, 'the expired index was being refreshed');
        assert.deepEqual(stale.errors, ['Sprites (Ubuntu 26.04 LTS (resolute)): Unknown package: figlett']);
        assert.deepEqual(stale.warnings, []);
    } finally { Date.now = realNow; }
});

test('the runtime package source checks a list against the index before an installation, not on every read', async () => {
    let loads = 0;
    setAgentImagePackageIndexLoader(async () => { loads++; return index(); });
    const source = indexCheckedAgentRuntimePackages(async () => ['figlet', 'figlett']);
    assert.deepEqual(await source(), ['figlet', 'figlett'], 'reading the list does not consult the index');
    assert.equal(loads, 0);
    await assert.rejects(source.checkAvailability!(['figlet', 'figlett']), (error: unknown) => {
        assert.ok(error instanceof AgentRuntimePackageUnavailableError);
        assert.deepEqual(error.unknown, ['figlett']);
        assert.match(error.message, /Unknown package: figlett\. The run was not started/);
        return true;
    });
    await source.checkAvailability!(['figlet']);
    loads = 0;
    setAgentImagePackageIndexLoader(async () => { loads++; return index(); });
    await indexCheckedAgentRuntimePackages(async () => [])().then(packages => source.checkAvailability!(packages));
    assert.equal(loads, 0, 'no packages, no index read');
});

function flyRun(packages: readonly string[]) {
    const launches: MachineLaunch[] = [];
    const api = {
        create: async (launch: MachineLaunch) => { launches.push(launch); throw new Error('stop after create'); },
        exec: async () => ({ stdout: '', exit_code: 1 }), logs: async () => {}, signal: async () => {}, destroy: async () => {},
    } as unknown as MachinesApi;
    const fly = new FlyMachinesRuntime(api, { PROPR_FLY_APP: 'index', PROPR_FLY_API_TOKEN: 'FlyV1 synthetic', PROPR_FLY_IMAGE: 'registry.fly.io/agents:current' },
        indexCheckedAgentRuntimePackages(async () => packages));
    const spec = new AgentRunSpecBuilder({
        agentType: 'claude', image: 'propr/agent', name: 'task', stdin: true, user: '0:0', network: agentRunNetwork('bridge'),
        workspace: { hostPath: '/unused', containerPath: '/home/node/workspace', readOnly: false, mode: 'clone',
            clone: { remote: 'unused', baseRef: 'base', baseCommit: '0123', branch: 'test', resultDir: RESULT, script: WORKSPACE_TRANSPORT_SCRIPT } },
    }).command('claude', '--version').build();
    return { run: fly.start(spec), launches };
}

test('a Fly run whose list the index rejects never creates a Machine', async () => {
    setAgentImagePackageIndexLoader(async () => index());
    const { run, launches } = flyRun(['figlett']);
    await assert.rejects(run.wait(), /Unknown package: figlett/);
    assert.deepEqual(launches, [], 'no agent Machine to install the list');
});

test('every Fly Machine start installs the list, so a name the refreshed index lost is refused before the next Machine', async () => {
    setAgentImagePackageIndexLoader(async () => index());
    const first = flyRun(['figlet']);
    await assert.rejects(first.run.wait(), /stop after create/);
    assert.equal(first.launches.length, 1, 'checked and created while the index has the name');
    setAgentImagePackageIndexLoader(async () => createAgentImagePackageIndex({ postfix: ['3.7.11-0+deb12u1'] }, ['mail-transport-agent']));
    const next = flyRun(['figlet']);
    await assert.rejects(next.run.wait(), /Unknown package: figlet/);
    assert.deepEqual(next.launches, []);
});

test('a Sprite is never created for a list the index rejects', async () => {
    setAgentImagePackageIndexLoader(async () => index());
    const client = new FakeSprites();
    const pool = new SpritePool(client, undefined, indexCheckedAgentRuntimePackages(async () => ['figlett']));
    await assert.rejects(pool.acquire(new AbortController().signal), /Unknown package: figlett/);
    assert.deepEqual(client.created, []);
    await pool.close();
});

test('a warm Sprite keeps serving a pinned version the refreshed index no longer lists; only a new Sprite is refused', async () => {
    const pinned = 'figlet=2.2.5-3+b1';
    setAgentImagePackageIndexLoader(async () => index());
    const client = new FakeSprites();
    const pool = new SpritePool(client, undefined, indexCheckedAgentRuntimePackages(async () => [pinned]));
    const signal = new AbortController().signal;
    const first = await pool.acquire(signal);
    await pool.release(first);
    // The archive moves on: the refreshed index carries only a newer figlet.
    setAgentImagePackageIndexLoader(async () => createAgentImagePackageIndex({ figlet: ['2.2.6-1'], postfix: ['3.7.11-0+deb12u1'] }, ['mail-transport-agent']));
    const reused = await pool.acquire(signal);
    assert.equal(reused.sprite.name, first.sprite.name, 'the clean checkpoint already has the pinned version');
    assert.equal(client.created.length, 1);
    // With the warm Sprite in use, the next run needs a new one: that installation is checked and refused.
    await assert.rejects(pool.acquire(signal), /Unknown version: figlet=2\.2\.5-3\+b1/);
    assert.equal(client.created.length, 1, 'no Sprite created to install a version the archive lacks');
    await pool.release(reused);
    await pool.close();
});

test('a warm Sprite keeps serving a package the refreshed index no longer has at all; a new Sprite for it is refused', async () => {
    setAgentImagePackageIndexLoader(async () => index());
    const client = new FakeSprites();
    const pool = new SpritePool(client, undefined, indexCheckedAgentRuntimePackages(async () => ['figlet']));
    const signal = new AbortController().signal;
    const first = await pool.acquire(signal);
    await pool.release(first);
    // The name leaves the archive entirely.
    setAgentImagePackageIndexLoader(async () => createAgentImagePackageIndex({ postfix: ['3.7.11-0+deb12u1'] }, ['mail-transport-agent']));
    const reused = await pool.acquire(signal);
    assert.equal(reused.sprite.name, first.sprite.name, 'the clean checkpoint with the same packages digest is reused');
    await assert.rejects(pool.acquire(signal), /Unknown package: figlet/);
    assert.equal(client.created.length, 1, 'no Sprite created to install a name the archive lacks');
    await pool.release(reused);
    await pool.close();
});
