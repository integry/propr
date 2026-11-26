import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import zlib from 'node:zlib';
import { FlyMachinesRuntime } from '../packages/core/src/agents/runtime/flyMachinesRuntime.ts';
import { AgentRunSpecBuilder, agentRunNetwork } from '../packages/core/src/agents/runtime/agentRunSpec.ts';
import { agentRuntimePackageInstallCommand } from '../packages/core/src/agents/runtime/agentRuntimePackageProfile.ts';
import type { MachineLaunch, MachineRef, MachinesApi } from '../packages/core/src/agents/runtime/fly/api.ts';
import { flyPackageImageTag, FlyPackageImages, resetFlyPackageImages } from '../packages/core/src/agents/runtime/fly/derivedImage.ts';
import { MEDIA, parseFlyImage, sha256, type ImageManifest, type RegistryApi } from '../packages/core/src/agents/runtime/fly/registry.ts';
import { RUN, WRAPPER, wrapper } from '../packages/core/src/agents/runtime/fly/wrapper.ts';
import { WORKSPACE_TRANSPORT_RESULT_DIR as RESULT, WORKSPACE_TRANSPORT_SCRIPT } from '../packages/core/src/git/workspaceTransportScript.ts';
import { closeConnection } from '../packages/core/src/db/connection.ts';

after(closeConnection);
beforeEach(resetFlyPackageImages);

const BASE_DIGEST = 'sha256:' + 'a'.repeat(64);
const TOKEN = 'FlyV1 synthetic-worker-credential';
const env = (app: string, extra: Record<string, string> = {}) => ({ PROPR_FLY_APP: app, PROPR_FLY_API_TOKEN: TOKEN,
    PROPR_FLY_IMAGE: 'registry.fly.io/agents@' + BASE_DIGEST, ...extra });

const layerTar = Buffer.from('a tar stream of the files apt installed');
const layerGz = zlib.gzipSync(layerTar);
const layer = { digest: sha256(layerGz), size: layerGz.length, diffId: sha256(layerTar), changed: 3, removed: 0 };

class Registry implements RegistryApi {
    tags = new Map<string, string>();
    blobs = new Map<string, Buffer>();
    manifests = new Map<string, { mediaType: string; body: Buffer }>();
    uploads: string[] = [];
    fail?: Error;
    lookups = 0;
    /** Base tags and the manifest digest each names now; a test may move one. */
    baseTags = new Map<string, string>([['current', BASE_DIGEST]]);
    /** When set, base manifest reads wait for it. */
    gate?: Promise<void>;
    baseConfig = Buffer.from(JSON.stringify({ architecture: 'amd64', os: 'linux', config: { User: 'node' },
        rootfs: { type: 'layers', diff_ids: ['sha256:' + '1'.repeat(64)] }, history: [{ created_by: 'base' }] }));
    base: ImageManifest = { schemaVersion: 2, mediaType: MEDIA.dockerManifest,
        config: { mediaType: 'application/vnd.docker.container.image.v1+json', digest: sha256(this.baseConfig), size: this.baseConfig.length },
        layers: [{ mediaType: MEDIA.dockerLayer, digest: 'sha256:' + '2'.repeat(64), size: 10 }] };
    constructor() { this.blobs.set(sha256(this.baseConfig), this.baseConfig); }
    async manifest(repository: string, reference: string) {
        this.lookups++;
        await this.gate;
        if (this.fail) throw this.fail;
        assert.equal(repository, 'agents');
        const digest = this.baseTags.get(reference) ?? reference;
        assert.ok([...this.baseTags.values(), BASE_DIGEST].includes(digest), reference);
        return { digest, manifest: this.base };
    }
    async resolve(_repository: string, tag: string) { return this.tags.get(tag); }
    async blob(_repository: string, digest: string) { return this.blobs.get(digest)!; }
    async upload(_repository: string, digest: string, size: number, content: Buffer | string) {
        const bytes = typeof content === 'string' ? fs.readFileSync(content) : content;
        assert.equal(bytes.length, size);
        assert.equal(sha256(bytes), digest);
        this.uploads.push(digest);
        this.blobs.set(digest, bytes);
    }
    async push(_repository: string, tag: string, mediaType: string, body: Buffer) {
        const digest = sha256(body);
        this.manifests.set(digest, { mediaType, body });
        this.tags.set(tag, digest);
        return digest;
    }
}

/** Build Machines report `buildState`; agent Machines finish as soon as they start. */
class Machines implements MachinesApi {
    launches: MachineLaunch[] = [];
    live = new Set<string>();
    peak = 0;
    events: string[] = [];
    started = new Set<string>();
    buildState = 'built';
    buildResult: Record<string, unknown> = { ms: 12_000, code: 0, tail: 'Setting up figlet', layer };
    async create(launch: MachineLaunch) {
        const id = 'm' + this.launches.length;
        this.launches.push(launch);
        this.live.add(id);
        this.peak = Math.max(this.peak, this.live.size);
        this.events.push('create ' + launch.config.processes[0].cmd[0]);
        return id;
    }
    private isBuild(id: string) { return this.launches[Number(id.slice(1))].config.processes[0].cmd[0] === 'build'; }
    async logs() {}
    async exec(id: string, args: string[]) {
        if (args[0] === '/usr/bin/touch') { if (args[1] === RUN + '/start') this.started.add(id); return { stdout: '', exit_code: 0 }; }
        if (args[0] === '/bin/cat' && args[1] === RUN + '/packages-result') return { stdout: JSON.stringify({ ms: 5, code: 0, tail: '' }), exit_code: 0 };
        if (args[0] === '/bin/cat') {
            assert.equal(args[1], RUN + '/build-result');
            return { stdout: JSON.stringify(this.buildResult), exit_code: 0 };
        }
        const [op, file, offset, length] = args.slice(3);
        if (op === 'probe') {
            if (this.isBuild(id)) return { stdout: this.buildState + '\n0', exit_code: 0 };
            return { stdout: this.started.has(id) ? 'exited 0\n1\n' : 'ready\n0', exit_code: 0 };
        }
        const files: Record<string, Buffer> = { [RUN + '/stdout']: Buffer.from('ok\n'), [RUN + '/stderr']: Buffer.alloc(0),
            [RUN + '/workspace/status']: Buffer.from('bundle test'), [RUN + '/workspace/result.bundle']: Buffer.from([1]),
            [RUN + '/layer.tar.gz']: layerGz };
        const data = files[file];
        if (op === 'size') return { stdout: String(data?.length), exit_code: data ? 0 : 44 };
        return { stdout: data!.subarray(+offset, +offset + +length).toString('base64'), exit_code: 0 };
    }
    async signal() {}
    async destroy(id: string) { this.live.delete(id); this.events.push('destroy ' + (this.isBuild(id) ? 'build' : 'launch')); }
    async gone(machine: MachineRef) { return !this.live.has(machine.id!); }
    file(launch: MachineLaunch, guestPath: string) {
        const entry = launch.config.files.find(f => f.guest_path === guestPath);
        return entry && Buffer.from(entry.raw_value, 'base64').toString();
    }
}

function spec(name = 'task') {
    return new AgentRunSpecBuilder({
        agentType: 'claude', image: 'propr/agent', name, stdin: true, user: '0:0', network: agentRunNetwork('bridge'),
        workspace: { hostPath: '/unused', containerPath: '/home/node/workspace', readOnly: false, mode: 'clone',
            clone: { remote: 'unused', baseRef: 'base', baseCommit: '0123', branch: 'test', resultDir: RESULT, script: WORKSPACE_TRANSPORT_SCRIPT } },
    }).command('claude', '--version').build();
}

const runtime = (api: Machines, registry: Registry, app: string, packages: string[], extra: Record<string, string> = {}) =>
    new FlyMachinesRuntime(api, env(app, extra), async () => packages, new FlyPackageImages(() => registry));

test('only registry.fly.io images with a tag or digest can be derived', () => {
    assert.deepEqual(parseFlyImage('registry.fly.io/agents@' + BASE_DIGEST), { repository: 'agents', reference: BASE_DIGEST });
    assert.deepEqual(parseFlyImage('registry.fly.io/agents:agent-1'), { repository: 'agents', reference: 'agent-1' });
    assert.deepEqual(parseFlyImage('registry.fly.io/agents:agent-1@' + BASE_DIGEST), { repository: 'agents', reference: BASE_DIGEST });
    for (const image of ['docker.io/propr/agent:1', 'registry.fly.io/agents', 'registry.fly.io/agents@sha256:test', 'registry.fly.io.evil/agents:1'])
        assert.equal(parseFlyImage(image), undefined, image);
    assert.notEqual(flyPackageImageTag(BASE_DIGEST, ['figlet']), flyPackageImageTag(BASE_DIGEST, ['figlet', 'jq']));
    assert.notEqual(flyPackageImageTag(BASE_DIGEST, ['figlet']), flyPackageImageTag('sha256:' + 'b'.repeat(64), ['figlet']));
    assert.match(flyPackageImageTag(BASE_DIGEST, ['figlet']), /^propr-packages-[0-9a-f]{24}$/);
});

test('the first run builds the derived image, the Machine runs it with nothing to install, and the next run reuses it', async () => {
    const api = new Machines();
    const registry = new Registry();
    const fly = runtime(api, registry, 'derive', ['figlet'], { PROPR_FLY_MACHINES_MAX: '1' });
    const first = fly.start(spec());
    assert.equal((await first.wait()).exitCode, 0);
    const [build, agent] = api.launches;
    // The build Machine starts from the base image by digest, runs the same apt argv as root and never sees the Fly token.
    assert.equal(build.config.image, 'registry.fly.io/agents@' + BASE_DIGEST);
    assert.deepEqual(build.config.processes[0].cmd, ['build']);
    assert.equal(build.config.processes[0].user, 'root');
    assert.equal(build.config.auto_destroy, true);
    assert.deepEqual(JSON.parse(api.file(build, RUN + '/build.json')!).argv, agentRuntimePackageInstallCommand(['figlet']));
    assert.equal(api.file(build, WRAPPER), wrapper);
    assert.ok(!JSON.stringify(build).includes('synthetic-worker-credential'));
    assert.ok(!JSON.stringify(build).includes(Buffer.from(TOKEN).toString('base64')));
    // The build Machine is deleted before the agent Machine is created, within one capacity slot.
    assert.deepEqual(api.events.slice(0, 3), ['create build', 'destroy build', 'create launch']);
    assert.equal(api.peak, 1);
    // The pushed manifest is the base plus the verified layer; the configuration gains its diff ID.
    const tag = flyPackageImageTag(BASE_DIGEST, ['figlet']);
    const digest = registry.tags.get(tag)!;
    assert.equal(agent.config.image, 'registry.fly.io/agents@' + digest);
    const pushed = registry.manifests.get(digest)!;
    assert.equal(pushed.mediaType, MEDIA.dockerManifest);
    const manifest = JSON.parse(pushed.body.toString()) as ImageManifest;
    assert.deepEqual(manifest.layers, [...registry.base.layers, { mediaType: MEDIA.dockerLayer, digest: layer.digest, size: layer.size }]);
    const config = JSON.parse(registry.blobs.get(manifest.config.digest)!.toString());
    assert.deepEqual(config.rootfs.diff_ids, ['sha256:' + '1'.repeat(64), layer.diffId]);
    assert.equal(config.config.User, 'node');
    assert.equal(config.history.length, 2);
    assert.equal(api.file(agent, RUN + '/packages.json'), undefined, 'no apt step at Machine start');
    await first.release!();

    resetFlyPackageImages(); // another worker, or a restart: the registry tag is the shared cache
    const second = fly.start(spec('second'));
    assert.equal((await second.wait()).exitCode, 0);
    assert.equal(api.launches.length, 3);
    assert.equal(api.launches[2].config.processes[0].cmd[0], 'launch');
    assert.equal(api.launches[2].config.image, 'registry.fly.io/agents@' + digest);
    await second.release!();
});

test('concurrent runs share one build', async () => {
    const api = new Machines();
    const fly = runtime(api, new Registry(), 'shared', ['figlet']);
    const runs = ['a', 'b', 'c'].map(name => fly.start(spec(name)));
    for (const run of runs) assert.equal((await run.wait()).exitCode, 0);
    assert.equal(api.launches.filter(l => l.config.processes[0].cmd[0] === 'build').length, 1);
    await Promise.all(runs.map(run => run.release!()));
});

test('an apt failure in the build fails the run with apt output and creates no agent Machine', async () => {
    const api = new Machines();
    api.buildState = 'build-failed';
    api.buildResult = { ms: 2000, code: 100, tail: 'E: Unable to locate package figlett' };
    const run = runtime(api, new Registry(), 'aptfail', ['figlett']).start(spec());
    await assert.rejects(run.wait(), /could not install the agent runtime packages .*apt exited with code 100[\s\S]*Unable to locate package figlett/);
    assert.deepEqual(api.events, ['create build', 'destroy build']);
});

test('a registry failure falls back to installing at Machine start, and is not retried at once', async () => {
    const api = new Machines();
    const registry = new Registry();
    registry.fail = new Error('Fly registry GET returned HTTP 401');
    const fly = runtime(api, registry, 'fallback', ['figlet']);
    for (const name of ['first', 'second']) {
        const run = fly.start(spec(name));
        assert.equal((await run.wait()).exitCode, 0);
        await run.release!();
    }
    assert.equal(api.launches.length, 2);
    assert.equal(registry.lookups, 1, 'the second run uses the fallback without asking the registry again');
    for (const launch of api.launches) {
        assert.equal(launch.config.image, 'registry.fly.io/agents@' + BASE_DIGEST);
        assert.deepEqual(JSON.parse(api.file(launch, RUN + '/packages.json')!).argv, agentRuntimePackageInstallCommand(['figlet']));
    }
});

test('an image outside registry.fly.io installs at Machine start', async () => {
    const api = new Machines();
    const run = new FlyMachinesRuntime(api, { ...env('elsewhere'), PROPR_FLY_IMAGE: 'docker.io/propr/agent:1' }, async () => ['figlet'],
        new FlyPackageImages(() => { throw new Error('no registry for this image'); })).start(spec());
    await run.wait().catch(() => {});
    assert.equal(api.launches.length, 1);
    assert.ok(api.file(api.launches[0], RUN + '/packages.json'));
    await run.release!().catch(() => {});
});

test('a layer that does not match its recorded digest is not pushed', async () => {
    const api = new Machines();
    const registry = new Registry();
    api.buildResult = { ms: 1, code: 0, tail: '', layer: { ...layer, diffId: 'sha256:' + 'f'.repeat(64) } };
    const run = runtime(api, registry, 'mismatch', ['figlet']).start(spec());
    await run.wait().catch(() => {});
    assert.equal(registry.tags.size, 0);
    assert.deepEqual(registry.uploads, []);
    assert.deepEqual(api.events.slice(0, 3), ['create build', 'destroy build', 'create launch']);
    assert.ok(api.file(api.launches[1], RUN + '/packages.json'), 'the run falls back to the start-time install');
    await run.release!().catch(() => {});
});

/** The build Machine's deletion fails; `gone` reports it present until the test says otherwise. */
class StuckBuilder extends Machines {
    present = true;
    override async destroy(id: string) {
        if (this.launches[Number(id.slice(1))].config.processes[0].cmd[0] === 'build') throw new Error('Fly API 503');
        return super.destroy(id);
    }
    override async gone(machine: MachineRef) { return machine.id === 'm0' ? !this.present : super.gone(machine); }
}

test('the run waits for the build Machine to be gone before creating its agent Machine', async () => {
    const api = new StuckBuilder();
    const run = runtime(api, new Registry(), 'stuck', ['figlet'], { PROPR_FLY_MACHINES_MAX: '1' }).start(spec());
    await delay(200);
    assert.deepEqual(api.events, ['create build'], 'no agent Machine while the build Machine may still exist');
    api.present = false; // its guest exited and Fly destroyed it
    assert.equal((await run.wait()).exitCode, 0);
    assert.deepEqual(api.events, ['create build', 'create launch', 'destroy launch']);
    await run.release!();
});

test('a cancelled run holds its slot until the build it started settles', async () => {
    const api = new Machines();
    const registry = new Registry();
    let open!: () => void;
    registry.gate = new Promise(resolve => { open = resolve; });
    const fly = runtime(api, registry, 'cancelled', ['figlet'], { PROPR_FLY_MACHINES_MAX: '1' });
    const cancel = new AbortController();
    const first = fly.start(spec('first'), { signal: cancel.signal });
    while (!registry.lookups) await delay(5);
    cancel.abort(new Error('cancelled')); // while the shared preparation awaits the registry, before its build Machine exists
    await assert.rejects(first.wait(), /cancelled/);
    await first.release?.().catch(() => {});
    // Settings now list no packages: the next run needs no image and creates its Machine once it has a slot.
    const second = runtime(api, registry, 'cancelled', [], { PROPR_FLY_MACHINES_MAX: '1' }).start(spec('second'));
    await delay(50);
    assert.deepEqual(api.events, [], 'the next run queues behind the preparation instead of taking the cancelled run\'s slot');
    open();
    assert.equal((await second.wait()).exitCode, 0);
    // The build Machine the cancelled run's preparation created is gone before the next run's agent Machine exists.
    assert.deepEqual(api.events, ['create build', 'destroy build', 'create launch', 'destroy launch']);
    assert.equal(api.peak, 1);
    assert.ok(registry.tags.get(flyPackageImageTag(BASE_DIGEST, ['figlet'])), 'the shared build still completed');
    await second.release!();
});

test('a base tag is resolved for every run, and a push to it selects a new derived image', async () => {
    const api = new Machines();
    const registry = new Registry();
    const fly = runtime(api, registry, 'tagged', ['figlet'], { PROPR_FLY_IMAGE: 'registry.fly.io/agents:current' });
    const go = async (name: string) => {
        const run = fly.start(spec(name));
        assert.equal((await run.wait()).exitCode, 0);
        await run.release!();
        return api.launches.at(-1)!;
    };
    const first = await go('first');
    const derivedA = 'registry.fly.io/agents@' + registry.tags.get(flyPackageImageTag(BASE_DIGEST, ['figlet']));
    assert.equal(first.config.image, derivedA);
    assert.equal((await go('unchanged')).config.image, derivedA, 'an unchanged tag reuses the cached image');
    assert.equal(api.launches.filter(l => l.config.processes[0].cmd[0] === 'build').length, 1);

    const moved = 'sha256:' + 'b'.repeat(64);
    registry.baseTags.set('current', moved); // the operator pushes a new base image to the same tag
    const third = await go('moved');
    const builds = api.launches.filter(l => l.config.processes[0].cmd[0] === 'build');
    assert.equal(builds.length, 2);
    assert.equal(builds[1].config.image, 'registry.fly.io/agents@' + moved, 'the new build starts from the manifest the tag names now');
    const derivedB = 'registry.fly.io/agents@' + registry.tags.get(flyPackageImageTag(moved, ['figlet']));
    assert.notEqual(derivedB, derivedA);
    assert.equal(third.config.image, derivedB);
    assert.equal(registry.lookups, 3, 'one base manifest read per run');
});

function python(code: string, ...args: string[]) {
    return execFileSync('python3', ['-I', '-c', wrapper + '\n' + code, ...args], { encoding: 'utf8' });
}

test('the wrapper layer holds what changed, whiteouts for removals, and matching digests', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fly-layer-'));
    try {
        for (const dir of ['usr/bin', 'usr/share/doc/old', 'etc', 'opt/propr', 'var/cache/apt/archives']) fs.mkdirSync(path.join(root, dir), { recursive: true });
        fs.writeFileSync(path.join(root, 'usr/bin/kept'), 'unchanged');
        fs.writeFileSync(path.join(root, 'usr/share/doc/old/readme'), 'removed with its directory');
        fs.writeFileSync(path.join(root, 'etc/config'), 'v1');
        fs.writeFileSync(path.join(root, 'etc/removed'), 'gone');
        const out = path.join(root, '..', path.basename(root) + '.tar.gz');
        const result = JSON.parse(python(`
root = sys.argv[1]
before = snapshot(root)
time.sleep(0.05)
open(os.path.join(root, 'usr/bin/figlet'), 'w').write('new binary')
os.symlink('figlet', os.path.join(root, 'usr/bin/figlet-link'))
open(os.path.join(root, 'etc/config'), 'w').write('v2')
os.remove(os.path.join(root, 'etc/removed'))
os.remove(os.path.join(root, 'usr/share/doc/old/readme'))
os.rmdir(os.path.join(root, 'usr/share/doc/old'))
open(os.path.join(root, 'opt/propr/ignored'), 'w').write('wrapper files are not image content')
open(os.path.join(root, 'var/cache/apt/archives/figlet.deb'), 'w').write('download cache')
print(json.dumps(write_layer(before, snapshot(root), sys.argv[2], root)))
`, root, out));
        const gz = fs.readFileSync(out);
        assert.equal(result.digest, sha256(gz));
        assert.equal(result.size, gz.length);
        assert.equal(result.diffId, sha256(zlib.gunzipSync(gz)));
        const members = python(`
import tarfile
with tarfile.open(sys.argv[1]) as tar:
    for m in tar.getmembers():
        print(m.name, m.type.decode(), m.linkname)
`, out).trim().split('\n').map(line => line.trimEnd());
        assert.deepEqual(members, [
            'etc 5', 'etc/.wh.removed 0', 'etc/config 0',
            'usr 5', 'usr/bin 5', 'usr/bin/figlet 0', 'usr/bin/figlet-link 2 figlet',
            'usr/share 5', 'usr/share/doc 5', 'usr/share/doc/.wh.old 0',
        ]);
        fs.rmSync(out);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('digests in the test fixtures are real sha256 values', () => {
    assert.equal(layer.digest, 'sha256:' + crypto.createHash('sha256').update(layerGz).digest('hex'));
});

test('the registry client resolves the amd64 manifest, uploads in chunks and keeps the token on registry.fly.io', async () => {
    const amd64 = Buffer.from(JSON.stringify(new Registry().base));
    const index = Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: MEDIA.ociIndex, manifests: [
        { mediaType: MEDIA.ociManifest, digest: 'sha256:' + '9'.repeat(64), size: 1, platform: { os: 'unknown', architecture: 'unknown' } },
        { mediaType: MEDIA.dockerManifest, digest: sha256(amd64), size: amd64.length, platform: { os: 'linux', architecture: 'amd64' } }] }));
    const calls: Array<{ method: string; url: string; auth: string | null }> = [];
    let tokenRequests = 0;
    const fetcher = (async (input: string | URL, init: RequestInit = {}) => {
        const url = new URL(String(input));
        const headers = new Headers(init.headers);
        const method = init.method ?? 'GET';
        if (url.pathname === '/token') {
            tokenRequests++;
            assert.equal(headers.get('authorization'), 'Basic ' + Buffer.from('x:' + TOKEN).toString('base64'));
            assert.equal(url.searchParams.get('scope'), 'repository:agents:pull,push');
            return Response.json({ token: 'registry-bearer' });
        }
        calls.push({ method, url: url.pathname + url.search, auth: headers.get('authorization') });
        if (headers.get('authorization') !== 'Bearer registry-bearer')
            return new Response(null, { status: 401, headers: { 'www-authenticate': 'Bearer realm="https://registry.fly.io/token",service="registry.fly.io",scope="repository:agents:pull,push"' } });
        if (url.pathname === '/v2/agents/manifests/agent-1') return new Response(index);
        if (url.pathname === '/v2/agents/manifests/' + sha256(amd64)) return new Response(amd64);
        if (method === 'HEAD' && url.pathname.includes('/blobs/')) return new Response(null, { status: 404 });
        if (method === 'POST') return new Response(null, { status: 202, headers: { location: '/v2/agents/blobs/uploads/u1?state=0' } });
        if (method === 'PATCH') {
            const body = Buffer.from(init.body as Uint8Array);
            assert.equal(headers.get('content-range'), `0-${body.length - 1}`);
            return new Response(null, { status: 202, headers: { location: 'https://registry.fly.io/v2/agents/blobs/uploads/u1?state=1' } });
        }
        if (method === 'PUT') return new Response(null, { status: 201 });
        throw new Error('unexpected ' + method + ' ' + url);
    }) as typeof fetch;
    const { FlyRegistry } = await import('../packages/core/src/agents/runtime/fly/registry.ts');
    const registry = new FlyRegistry(TOKEN, fetcher);
    const resolved = await registry.manifest('agents', 'agent-1');
    assert.equal(resolved.digest, sha256(amd64));
    assert.equal(tokenRequests, 1);
    await registry.upload('agents', layer.digest, layer.size, layerGz);
    const put = calls.find(c => c.method === 'PUT')!;
    assert.equal(put.url, '/v2/agents/blobs/uploads/u1?state=1&digest=' + encodeURIComponent(layer.digest));
    assert.ok(calls.slice(1).every(c => c.auth === 'Bearer registry-bearer'));
    // An upload location elsewhere never receives the token.
    await assert.rejects((registry as unknown as { request(m: string, p: string): Promise<Response> }).request('PATCH', 'https://example.com/upload'),
        /Refusing to send the Fly token/);
});
