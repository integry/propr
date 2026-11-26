import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { closeConnection } from '../packages/core/src/db/connection.ts';
import {
    AgentRuntimeCapabilityError, assertRuntimePackagesSupported, runtimePackagesRefusal,
} from '../packages/core/src/agents/runtime/registry.ts';
import { DOCKER_RUNTIME_CAPABILITIES } from '../packages/core/src/agents/runtime/dockerRuntime.ts';
import { FlyMachinesRuntime } from '../packages/core/src/agents/runtime/flyMachinesRuntime.ts';
import { SpritesRuntime } from '../packages/core/src/agents/runtime/spritesRuntime.ts';
import { SpritePool } from '../packages/core/src/agents/runtime/sprites/spritesProvisioning.ts';
import {
    agentRuntimePackageInstallCommand, agentRuntimePackagesDigest,
} from '../packages/core/src/agents/runtime/agentRuntimePackageProfile.ts';
import { FakeSprites, type FakeSprite } from './helpers/fakeSprites.ts';

after(closeConnection);

const docker = { kind: 'docker', capabilities: DOCKER_RUNTIME_CAPABILITIES };
const fly = { kind: 'fly-machines', capabilities: FlyMachinesRuntime.capabilities };
const sprites = { kind: 'sprites', capabilities: SpritesRuntime.capabilities };

test('runtimes declare whether they apply runtime packages; Fly Machines are refused while packages are configured', () => {
    assert.equal(DOCKER_RUNTIME_CAPABILITIES.supportsRuntimePackages, true);
    assert.equal(SpritesRuntime.capabilities.supportsRuntimePackages, true);
    assert.equal(FlyMachinesRuntime.capabilities.supportsRuntimePackages, false);
    assert.equal(runtimePackagesRefusal(docker, ['postgresql-client']), undefined);
    assert.equal(runtimePackagesRefusal(sprites, ['postgresql-client']), undefined);
    assert.equal(runtimePackagesRefusal(fly, []), undefined, 'no packages configured: nothing to refuse');
    const refusal = runtimePackagesRefusal(fly, ['postgresql-client']);
    assert.match(refusal!, /"fly-machines" cannot install the configured runtime packages \(postgresql-client\)/);
    assert.match(refusal!, /\(docker, sprites\)/);
    assert.match(refusal!, /\.propr\/setup\.sh/);
    // A custom runtime that declares nothing is not assumed to install them.
    assert.ok(runtimePackagesRefusal({ kind: 'custom', capabilities: {} }, ['jq']));
    assert.match(runtimePackagesRefusal(fly, ['a', 'b', 'c', 'd', 'e', 'f', 'g'])!, /\(a, b, c, d, e, and 2 more\)/);
});

test('the launch check refuses with a typed capability error and reads packages only for runtimes that cannot apply them', async () => {
    let reads = 0;
    const load = async () => { reads++; return ['postgresql-client']; };
    await assertRuntimePackagesSupported(docker, { name: 'run-1' }, load);
    await assertRuntimePackagesSupported(sprites, { name: 'run-1' }, load);
    assert.equal(reads, 0);
    await assert.rejects(assertRuntimePackagesSupported(fly, { name: 'run-1' }, load), (error: unknown) => {
        assert.ok(error instanceof AgentRuntimeCapabilityError);
        assert.equal(error.capability, 'runtime_packages');
        assert.equal(error.runtime, 'fly-machines');
        assert.match(error.message, /\(run run-1\)$/);
        return true;
    });
    await assertRuntimePackagesSupported(fly, { name: 'run-2' }, async () => []);
    await assert.rejects(assertRuntimePackagesSupported(fly, { name: 'run-3' }, async () => { throw new Error('settings unreadable'); }),
        /settings unreadable/, 'an unreadable package list fails closed');
});

test('the install command passes package specs as arguments and refuses invalid or empty lists', () => {
    const argv = agentRuntimePackageInstallCommand(['postgresql-client', 'jq=1.7.1-3']);
    assert.deepEqual(argv.slice(0, 4), ['env', 'DEBIAN_FRONTEND=noninteractive', '/bin/bash', '-c']);
    assert.match(argv[4], /apt-get install -y --allow-downgrades --no-install-recommends "\$@"/);
    assert.deepEqual(argv.slice(5), ['propr-runtime-packages', 'jq=1.7.1-3', 'postgresql-client']);
    assert.throws(() => agentRuntimePackageInstallCommand(['bad;rm -rf /']), /invalid package spec/);
    assert.throws(() => agentRuntimePackageInstallCommand([]), /empty/);
    assert.equal(agentRuntimePackagesDigest(['b', 'a']), agentRuntimePackagesDigest(['a', 'b']));
    assert.notEqual(agentRuntimePackagesDigest([]), agentRuntimePackagesDigest(['a']));
});

function recordingClient(failInstall?: string) {
    const client = new FakeSprites();
    const calls = new Map<string, string[]>();
    client.setup = (sprite: FakeSprite) => {
        const log: string[] = [];
        calls.set(sprite.name, log);
        const execFile = sprite.execFile.bind(sprite);
        sprite.execFile = async (cmd, args, options) => {
            if (args.includes('propr-runtime-packages')) {
                log.push('install ' + args.slice(args.indexOf('propr-runtime-packages') + 1).join(' '));
                if (failInstall) throw Object.assign(new Error('Command failed with exit code 100'), { stderr: failInstall });
                return { exitCode: 0, stdout: '', stderr: '' };
            }
            if (args.some(arg => arg.endsWith('sprites-agent-setup.sh'))) log.push('setup');
            return execFile(cmd, args, options);
        };
        const createCheckpoint = sprite.createCheckpoint.bind(sprite);
        sprite.createCheckpoint = async () => { log.push('checkpoint'); return createCheckpoint(); };
    };
    return { client, calls };
}

test('Sprites install the configured packages after setup and before the clean checkpoint', async () => {
    const { client, calls } = recordingClient();
    const pool = new SpritePool(client, undefined, async () => ['postgresql-client']);
    const slot = await pool.acquire(new AbortController().signal);
    assert.deepEqual(calls.get(slot.sprite.name), ['setup', 'install postgresql-client', 'checkpoint']);
    assert.equal(slot.packagesDigest, agentRuntimePackagesDigest(['postgresql-client']));
    await pool.release(slot);
    await pool.close();
});

test('without configured packages Sprites skip the install step', async () => {
    const { client, calls } = recordingClient();
    const pool = new SpritePool(client);
    const slot = await pool.acquire(new AbortController().signal);
    assert.deepEqual(calls.get(slot.sprite.name), ['setup', 'checkpoint']);
    await pool.release(slot);
    await pool.close();
});

test('a package change retires the warm Sprite and the next run gets a newly provisioned one', async () => {
    const { client, calls } = recordingClient();
    let packages = ['postgresql-client'];
    const pool = new SpritePool(client, undefined, async () => packages);
    const signal = new AbortController().signal;
    const first = await pool.acquire(signal);
    await pool.release(first);
    const reused = await pool.acquire(signal);
    assert.equal(reused.sprite.name, first.sprite.name, 'unchanged packages reuse the warm Sprite');
    await pool.release(reused);
    packages = ['jq', 'postgresql-client'];
    const fresh = await pool.acquire(signal);
    assert.notEqual(fresh.sprite.name, first.sprite.name);
    assert.ok(client.deleted.includes(first.sprite.name), 'the Sprite with the old package set is deleted');
    assert.deepEqual(calls.get(fresh.sprite.name), ['setup', 'install jq postgresql-client', 'checkpoint']);
    await pool.release(fresh);
    await pool.close();
});

test('an apt failure fails provisioning with the apt error and deletes the Sprite', async () => {
    const { client } = recordingClient('E: Unable to locate package postgresql-clent');
    const pool = new SpritePool(client, undefined, async () => ['postgresql-clent']);
    await assert.rejects(pool.acquire(new AbortController().signal),
        /Failed to provision the clean Sprite checkpoint: E: Unable to locate package postgresql-clent/);
    assert.deepEqual(client.deleted, [client.created[0].name]);
    await pool.close();
});
