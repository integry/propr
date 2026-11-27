/**
 * Fly dashboard launch (#3827): the committed fly.toml files (root: the
 * released image; deploy/fly/source/fly.toml: build from source) and the
 * container entry stay generated from the `propr deploy fly` builders, so
 * they cannot drift from the CLI or from each other.
 * Run with: npx tsx --test test/flyLaunchLayout.test.ts
 * Regenerate fly.toml with: npx tsx packages/cli/scripts/render-fly-launch-toml.ts
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import { test } from 'node:test';
import { FLY_GENERATED_SECRETS } from '@propr/shared';
import { buildAppEnv, FLY_REDIS_PERSISTENCE_FLAGS, type FlyDeployPlan } from '../packages/cli/src/commands/deploy/flyMachineConfig.ts';
import {
    FLY_LAUNCH_BOOT_ENV_KEYS, FLY_LAUNCH_DOCKERFILE, FLY_LAUNCH_ENTRYPOINT, FLY_LAUNCH_MISSING_ENTRY_MESSAGE, FLY_LAUNCH_PROCESS_SCRIPT,
    FLY_LAUNCH_SOURCE_CONFIG, flyLaunchConfigs, flyLaunchEnv, flyLaunchPlan, renderFlyLaunchToml,
} from '../packages/cli/src/commands/deploy/flyLaunchToml.ts';
import { applyLaunchEnv, readLaunchConfig } from '../src/flyLaunch/launchConfig.ts';
import { createLaunchStore } from '../src/flyLaunch/launchStore.ts';
import { resolveFlyMachineStop } from '../src/flyMachineStop.ts';

const root = new URL('..', import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, root), 'utf8');

const version = (JSON.parse(read('package.json')) as { version: string }).version;
const configs = flyLaunchConfigs(version);
const configPaths = configs.map((config) => config.path);

/** A config with its [build] table (up to the next table) removed. */
const withoutBuild = (toml: string): string => toml.replace(/^\[build\]\n(?:(?!\[).*\n)*/m, '');

test('the committed fly.toml files are the generated ones (npx tsx packages/cli/scripts/render-fly-launch-toml.ts)', () => {
    assert.deepEqual(configPaths, ['fly.toml', FLY_LAUNCH_SOURCE_CONFIG]);
    for (const config of configs) assert.equal(read(config.path), renderFlyLaunchToml(config.path, config.build), config.path);
});

test('the root fly.toml pulls the released app image pinned to the package version', () => {
    const toml = read('fly.toml');
    assert.match(toml, new RegExp(`^  image = "propr/app:${version.replaceAll('.', '\\.')}"$`, 'm'));
    assert.doesNotMatch(toml, /^\s*dockerfile\s*=/m);
    assert.doesNotMatch(toml, /:latest"/);
});

test('the source config builds the app Dockerfile, resolved from its own directory as flyctl does', () => {
    const toml = read(FLY_LAUNCH_SOURCE_CONFIG);
    const dockerfile = /^  dockerfile = "([^"]+)"$/m.exec(toml)?.[1];
    assert.ok(dockerfile, 'dockerfile is set');
    // flyctl: filepath.Join(filepath.Dir(configPath), build.dockerfile); the build context is the working directory.
    assert.equal(posix.join(posix.dirname(FLY_LAUNCH_SOURCE_CONFIG), dockerfile), FLY_LAUNCH_DOCKERFILE);
    assert.ok(existsSync(new URL(posix.join(posix.dirname(FLY_LAUNCH_SOURCE_CONFIG), dockerfile), root)));
    assert.doesNotMatch(toml, /^\s*image\s*=/m);
});

test('the two configs differ only in [build]', () => {
    const [prebuilt, source] = configPaths.map((path) => read(path));
    const body = (toml: string): string => withoutBuild(toml).split('\n').filter((line) => !line.startsWith('# ')).join('\n');
    assert.ok(body(prebuilt).includes('[env]') && body(prebuilt).includes('[[vm]]'));
    assert.equal(body(prebuilt), body(source));
    assert.notEqual(prebuilt, source);
});

for (const path of configPaths) test(`${path} holds no secrets and no account-specific values`, () => {
    const toml = read(path);
    assert.doesNotMatch(toml, /^app\s*=/m);
    assert.doesNotMatch(toml, /^primary_region\s*=/m);
    for (const spec of FLY_GENERATED_SECRETS) assert.ok(!toml.includes(spec.name), spec.name);
    for (const key of FLY_LAUNCH_BOOT_ENV_KEYS) assert.ok(!(key in flyLaunchEnv()), `${key} is derived or chosen at boot`);
    assert.doesNotMatch(toml, /fly\.dev/);
    assert.match(toml, /auto_start_machines = true/);
    assert.match(toml, /auto_stop_machines = "off"/);
});

test('env at boot matches what propr deploy fly sets for the same app', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fly-launch-layout-'));
    try {
        const store = createLaunchStore(join(dir, 'fly-launch'));
        const env: NodeJS.ProcessEnv = { ...flyLaunchEnv(), FLY_APP_NAME: 'my-propr' };
        applyLaunchEnv(env, store, readLaunchConfig(store), { mcp: true, keyExists: () => false });
        for (const key of ['FLY_APP_NAME', 'PROPR_FLY_LAUNCH', 'PROPR_FLY_EXIT_STOPS_MACHINE']) delete env[key];
        const plan: FlyDeployPlan = { ...flyLaunchPlan(), app: 'my-propr' };
        assert.deepEqual(env, buildAppEnv(plan));
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('the entry runs Redis with the CLI flags and starts the launch entry', () => {
    const script = read(FLY_LAUNCH_ENTRYPOINT);
    assert.ok(script.includes(`--bind 127.0.0.1 --port "$redis_port" --dir "$redis_dir" ${FLY_REDIS_PERSISTENCE_FLAGS} &`));
    assert.match(script, /^node dist\/src\/flyLaunch\.js &$/m);
    for (const path of configPaths) assert.ok(read(path).includes(`  app = ${JSON.stringify(`sh -c '${FLY_LAUNCH_PROCESS_SCRIPT}'`)}\n`), path);
    const dockerfile = read(FLY_LAUNCH_DOCKERFILE);
    assert.match(dockerfile, new RegExp(`COPY ${FLY_LAUNCH_ENTRYPOINT} \\./${FLY_LAUNCH_ENTRYPOINT}`));
    assert.match(dockerfile, /apk add --no-cache [^\n]* valkey valkey-cli/);
});

test('an image without the launch entry logs how to build from source and exits 0 (stays stopped)', () => {
    assert.doesNotMatch(FLY_LAUNCH_PROCESS_SCRIPT, /'/, 'fits in one single-quoted sh -c argument');
    const dir = mkdtempSync(join(tmpdir(), 'fly-launch-process-'));
    try {
        const missing = spawnSync('sh', ['-c', FLY_LAUNCH_PROCESS_SCRIPT], { cwd: dir, encoding: 'utf8' });
        assert.equal(missing.status, 0);
        assert.equal(missing.stdout, '');
        assert.equal(missing.stderr.trim(), FLY_LAUNCH_MISSING_ENTRY_MESSAGE);
        assert.ok(missing.stderr.includes(FLY_LAUNCH_SOURCE_CONFIG));

        const entry = join(dir, FLY_LAUNCH_ENTRYPOINT);
        mkdirSync(dirname(entry), { recursive: true });
        writeFileSync(entry, 'echo started "$$" >&2\nexit 3\n');
        chmodSync(entry, 0o644);
        const present = spawnSync('sh', ['-c', `echo $$; ${FLY_LAUNCH_PROCESS_SCRIPT}`], { cwd: dir, encoding: 'utf8' });
        assert.equal(present.status, 3, 'the entry exit code is the container exit code');
        assert.equal(present.stderr.trim(), `started ${present.stdout.trim()}`, 'exec keeps the same process');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('in the one-container launch an idle exit is the stop; the CLI layout still needs its token', () => {
    const machine = { FLY_MACHINE_ID: 'm1', FLY_APP_NAME: 'my-propr' };
    assert.equal(resolveFlyMachineStop({ ...machine, PROPR_FLY_EXIT_STOPS_MACHINE: '1' }).kind, 'not_fly');
    assert.equal(resolveFlyMachineStop(machine).kind, 'unavailable');
});
