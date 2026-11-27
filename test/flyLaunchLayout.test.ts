/**
 * Fly dashboard launch (#3827): the committed fly.toml and container entry
 * stay generated from the `propr deploy fly` builders, so they cannot drift.
 * Run with: npx tsx --test test/flyLaunchLayout.test.ts
 * Regenerate fly.toml with: npx tsx packages/cli/scripts/render-fly-launch-toml.ts
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FLY_GENERATED_SECRETS } from '@propr/shared';
import { buildAppEnv, FLY_REDIS_PERSISTENCE_FLAGS, type FlyDeployPlan } from '../packages/cli/src/commands/deploy/flyMachineConfig.ts';
import {
    FLY_LAUNCH_BOOT_ENV_KEYS, FLY_LAUNCH_DOCKERFILE, FLY_LAUNCH_ENTRYPOINT, flyLaunchEnv, flyLaunchPlan, renderFlyLaunchToml,
} from '../packages/cli/src/commands/deploy/flyLaunchToml.ts';
import { applyLaunchEnv, readLaunchConfig } from '../src/flyLaunch/launchConfig.ts';
import { createLaunchStore } from '../src/flyLaunch/launchStore.ts';
import { resolveFlyMachineStop } from '../src/flyMachineStop.ts';

const root = new URL('..', import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, root), 'utf8');

test('the committed fly.toml is the generated one (npx tsx packages/cli/scripts/render-fly-launch-toml.ts)', () => {
    assert.equal(read('fly.toml'), renderFlyLaunchToml());
});

test('fly.toml holds no secrets and no account-specific values', () => {
    const toml = read('fly.toml');
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
    assert.match(read('fly.toml'), new RegExp(`app = "sh ${FLY_LAUNCH_ENTRYPOINT.replace('.', '\\.')}"`));
    const dockerfile = read(FLY_LAUNCH_DOCKERFILE);
    assert.match(dockerfile, new RegExp(`COPY ${FLY_LAUNCH_ENTRYPOINT} \\./${FLY_LAUNCH_ENTRYPOINT}`));
    assert.match(dockerfile, /apk add --no-cache [^\n]* valkey valkey-cli/);
});

test('in the one-container launch an idle exit is the stop; the CLI layout still needs its token', () => {
    const machine = { FLY_MACHINE_ID: 'm1', FLY_APP_NAME: 'my-propr' };
    assert.equal(resolveFlyMachineStop({ ...machine, PROPR_FLY_EXIT_STOPS_MACHINE: '1' }).kind, 'not_fly');
    assert.equal(resolveFlyMachineStop(machine).kind, 'unavailable');
});
