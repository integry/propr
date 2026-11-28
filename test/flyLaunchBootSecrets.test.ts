/**
 * Fly dashboard launch (#3827): secrets generated once on first boot, kept on
 * the volume, and overridden by Fly secrets.
 * Run with: npx tsx --test test/flyLaunchBootSecrets.test.ts
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { FLY_GENERATED_SECRETS } from '@propr/shared';
import { BOOT_SECRETS_FILE, ensureBootSecrets } from '../src/flyLaunch/bootSecrets.ts';
import { createLaunchStore } from '../src/flyLaunch/launchStore.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function freshStore() {
    const root = mkdtempSync(join(tmpdir(), 'fly-launch-secrets-'));
    dirs.push(root);
    return createLaunchStore(join(root, 'fly-launch'));
}

let counter = 0;
const countingRandom = (size: number): Buffer => Buffer.alloc(size, ++counter);

test('first boot generates every CLI secret once and stores it with mode 0600', () => {
    const store = freshStore();
    const env: NodeJS.ProcessEnv = {};
    const result = ensureBootSecrets(env, store, countingRandom);
    assert.deepEqual(result.generated, FLY_GENERATED_SECRETS.map(spec => spec.name));
    assert.deepEqual(result.fromEnvironment, []);
    for (const spec of FLY_GENERATED_SECRETS) assert.ok(env[spec.name], `${spec.name} set`);
    assert.equal(Buffer.from(env.MCP_ENCRYPTION_KEY!, 'base64').length, 32);
    assert.match(env.SESSION_SECRET!, /^[0-9a-f]{64}$/);
    assert.notEqual(env.SESSION_SECRET, env.SYSTEM_TASK_SECRET);

    const file = store.path(BOOT_SECRETS_FILE);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(store.dir).mode & 0o777, 0o700);
    const stored = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(stored.SYSTEM_TASK_SECRET, env.SYSTEM_TASK_SECRET);
});

test('later boots (restart, wake after an idle stop) reuse the stored secrets without generating', () => {
    const store = freshStore();
    const first: NodeJS.ProcessEnv = {};
    ensureBootSecrets(first, store, countingRandom);
    const before = readFileSync(store.path(BOOT_SECRETS_FILE), 'utf8');

    const second: NodeJS.ProcessEnv = {};
    const result = ensureBootSecrets(second, store, () => { throw new Error('must not generate'); });
    assert.deepEqual(result.generated, []);
    assert.deepEqual(result.fromVolume, FLY_GENERATED_SECRETS.map(spec => spec.name));
    for (const spec of FLY_GENERATED_SECRETS) assert.equal(second[spec.name], first[spec.name]);
    assert.equal(readFileSync(store.path(BOOT_SECRETS_FILE), 'utf8'), before);
});

test('Fly secrets win: they are used as is, never stored, and the stored value stays for later', () => {
    const store = freshStore();
    const first: NodeJS.ProcessEnv = {};
    ensureBootSecrets(first, store, countingRandom);

    const env: NodeJS.ProcessEnv = { SESSION_SECRET: 'from-fly', SYSTEM_TASK_SECRET: 'fly-system' };
    const result = ensureBootSecrets(env, store, countingRandom);
    assert.deepEqual(result.fromEnvironment, ['SESSION_SECRET', 'SYSTEM_TASK_SECRET']);
    assert.equal(env.SESSION_SECRET, 'from-fly');
    assert.equal(env.SYSTEM_TASK_SECRET, 'fly-system');
    const stored = JSON.parse(readFileSync(store.path(BOOT_SECRETS_FILE), 'utf8'));
    assert.equal(stored.SESSION_SECRET, first.SESSION_SECRET);
    assert.ok(!JSON.stringify(stored).includes('from-fly'));
});

test('an instance configured entirely with Fly secrets writes nothing to the volume', () => {
    const store = freshStore();
    const env: NodeJS.ProcessEnv = Object.fromEntries(FLY_GENERATED_SECRETS.map(spec => [spec.name, `fly-${spec.name}`]));
    const result = ensureBootSecrets(env, store, () => { throw new Error('must not generate'); });
    assert.equal(result.generated.length, 0);
    assert.equal(store.readJson(BOOT_SECRETS_FILE), undefined);
});

test('the MCP key is generated only when the launch turns ProPR MCP on (as propr deploy fly)', () => {
    const store = freshStore();
    const env: NodeJS.ProcessEnv = { MCP_ENABLED: 'false' };
    const result = ensureBootSecrets(env, store, countingRandom);
    assert.deepEqual(result.generated, ['SESSION_SECRET', 'SYSTEM_TASK_SECRET']);
    assert.equal(env.MCP_ENCRYPTION_KEY, undefined);
});

test('results name secrets only, never their values', () => {
    const store = freshStore();
    const env: NodeJS.ProcessEnv = {};
    const result = ensureBootSecrets(env, store, countingRandom);
    const reported = JSON.stringify(result);
    for (const spec of FLY_GENERATED_SECRETS) assert.ok(!reported.includes(env[spec.name]!));
});
