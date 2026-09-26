import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, linkSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { AUTOMATIC_VAPID_SUBJECT, resolveInstanceWebPushConfiguration } from '../services/instanceWebPushConfiguration.js';
import { WEB_PUSH_CONFIGURATION_WARNINGS, validateWebPushConfiguration } from '../services/webPushConfiguration.js';

function fixture(t: { after: (fn: () => void) => void }, root = tmpdir()) {
  const directory = mkdtempSync(join(root, 'propr-vapid-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, environment: { DATA_DIR: directory }, filename: join(directory, 'web-push/vapid.json') };
}

test('fresh instance persists a valid restricted pair; restarts and subject changes reuse it', t => {
  const { environment, filename } = fixture(t);
  const first = resolveInstanceWebPushConfiguration(environment);
  assert.ok(first.configured);
  assert.equal(first.subject, AUTOMATIC_VAPID_SUBJECT);
  assert.ok(validateWebPushConfiguration(first).configured);
  assert.equal(statSync(filename).mode & 0o777, 0o600);
  assert.equal(statSync(join(environment.DATA_DIR, 'web-push')).mode & 0o777, 0o700);
  const stored = readFileSync(filename, 'utf8');
  const restarted = resolveInstanceWebPushConfiguration({ ...environment, API_PUBLIC_URL: 'https://instance.example/path?secret=ignored' });
  assert.ok(restarted.configured);
  assert.equal(restarted.publicKey, first.publicKey);
  assert.equal(restarted.subject, 'https://instance.example');
  assert.equal(readFileSync(filename, 'utf8'), stored);
  assert.deepEqual(readdirSync(join(environment.DATA_DIR, 'web-push')), ['vapid.json']);
});

test('uses the mounted database directory ahead of DATA_DIR and avoids database side effects', t => {
  const { directory } = fixture(t);
  const database = join(directory, 'mounted', 'propr.sqlite');
  assert.ok(resolveInstanceWebPushConfiguration({ DB_FILENAME: database, DATA_DIR: join(directory, 'unused') }).configured);
  assert.ok(existsSync(join(directory, 'mounted/web-push/vapid.json')));
  assert.equal(existsSync(database), false);
  assert.equal(existsSync(join(directory, 'unused')), false);
});

test('explicit pair wins without touching storage; removing it resumes the existing automatic identity', t => {
  const { environment, filename } = fixture(t);
  const other = fixture(t);
  const automatic = resolveInstanceWebPushConfiguration(environment);
  const manual = resolveInstanceWebPushConfiguration(other.environment);
  assert.ok(automatic.configured && manual.configured);
  const stored = readFileSync(filename, 'utf8');
  const selected = resolveInstanceWebPushConfiguration({ ...environment,
    WEB_PUSH_VAPID_PUBLIC_KEY: manual.publicKey, WEB_PUSH_VAPID_PRIVATE_KEY: manual.privateKey,
    WEB_PUSH_VAPID_SUBJECT: 'mailto:operator@example.com',
  });
  assert.ok(selected.configured);
  assert.equal(selected.publicKey, manual.publicKey);
  assert.equal(selected.subject, 'mailto:operator@example.com');
  assert.equal(readFileSync(filename, 'utf8'), stored);
  assert.deepEqual(resolveInstanceWebPushConfiguration(environment), automatic);
});

test('subject override works alone; trusted HTTPS origin or project URL is used by default', t => {
  const { environment } = fixture(t);
  for (const [extra, subject] of [
    [{ WEB_PUSH_VAPID_SUBJECT: 'https://contact.example/push' }, 'https://contact.example/push'],
    [{ API_PUBLIC_URL: 'http://localhost:4000', FRONTEND_URL: 'https://ui.example' }, 'https://ui.example'],
    [{ API_PUBLIC_URL: 'HTTPS://instance.example/path' }, 'https://instance.example'],
    [{ API_PUBLIC_URL: 'https://localhost:4000' }, AUTOMATIC_VAPID_SUBJECT],
    [{ API_PUBLIC_URL: 'https://user:password@example.com', HOST: 'attacker.example' }, AUTOMATIC_VAPID_SUBJECT],
  ] as const) {
    const result = resolveInstanceWebPushConfiguration({ ...environment, ...extra });
    assert.ok(result.configured);
    assert.equal(result.subject, subject);
  }
});

test('disabled, partial, malformed, mismatched and invalid subject configs never create storage', t => {
  const source = fixture(t);
  const pair = resolveInstanceWebPushConfiguration(source.environment);
  assert.ok(pair.configured);
  const other = resolveInstanceWebPushConfiguration(fixture(t).environment);
  assert.ok(other.configured);
  for (const [extra, issue] of [
    [{ WEB_PUSH_ENABLED: 'false' }, 'disabled'],
    [{ WEB_PUSH_VAPID_PRIVATE_KEY: pair.privateKey }, 'missing'],
    [{ WEB_PUSH_VAPID_PUBLIC_KEY: pair.publicKey }, 'missing'],
    [{ WEB_PUSH_VAPID_SUBJECT: 'invalid-private-sentinel' }, 'invalid_subject'],
    [{ WEB_PUSH_VAPID_PUBLIC_KEY: 'invalid-private-sentinel', WEB_PUSH_VAPID_PRIVATE_KEY: pair.privateKey }, 'malformed'],
    [{ WEB_PUSH_VAPID_PUBLIC_KEY: other.publicKey, WEB_PUSH_VAPID_PRIVATE_KEY: pair.privateKey }, 'mismatched'],
  ] as const) {
    const { environment, directory } = fixture(t);
    const result = resolveInstanceWebPushConfiguration({ ...environment, ...extra });
    assert.deepEqual(result, { configured: false, issue });
    assert.deepEqual(readdirSync(directory), []);
    const output = JSON.stringify({ result, warnings: WEB_PUSH_CONFIGURATION_WARNINGS });
    assert.ok(!output.includes(pair.privateKey) && !output.includes('invalid-private-sentinel'));
  }
});

test('corrupt or unsafe persisted data fails closed without overwriting; backup restore recovers', t => {
  const { environment, filename } = fixture(t);
  const first = resolveInstanceWebPushConfiguration(environment);
  const backup = readFileSync(filename, 'utf8');
  for (const corrupt of ['{private-sentinel', '{}', '{"version":1,"publicKey":"bad","privateKey":"private-sentinel"}']) {
    writeFileSync(filename, corrupt);
    assert.deepEqual(resolveInstanceWebPushConfiguration(environment), { configured: false, issue: 'storage_invalid' });
    assert.equal(readFileSync(filename, 'utf8'), corrupt);
  }
  writeFileSync(filename, backup);
  chmodSync(filename, 0o644);
  assert.deepEqual(resolveInstanceWebPushConfiguration(environment), { configured: false, issue: 'storage_invalid' });
  chmodSync(filename, 0o600);
  assert.deepEqual(resolveInstanceWebPushConfiguration(environment), first);
});

test('failed persistence advertises no transient key; retries reuse an already published identity', t => {
  for (const boundary of ['temporary-synced', 'published', 'directory-synced'] as const) {
    const { environment, filename } = fixture(t);
    const result = resolveInstanceWebPushConfiguration(environment, { onBoundary: current => {
      if (current === boundary) throw new Error('private-sentinel');
    } });
    assert.deepEqual(result, { configured: false, issue: 'storage_unavailable' });
    const published = existsSync(filename) ? readFileSync(filename, 'utf8') : undefined;
    assert.ok(resolveInstanceWebPushConfiguration(environment).configured);
    if (published) assert.equal(readFileSync(filename, 'utf8'), published);
  }
  const { environment, directory } = fixture(t);
  writeFileSync(join(directory, 'web-push'), 'blocked');
  assert.deepEqual(resolveInstanceWebPushConfiguration(environment), { configured: false, issue: 'storage_unavailable' });
  rmSync(join(directory, 'web-push'));
  assert.ok(resolveInstanceWebPushConfiguration(environment).configured);
});

const SERVICES = fileURLToPath(new URL('../services/', import.meta.url));

// Self-hosted CI sets TMPDIR to a private 0700 directory, which an unprivileged child
// cannot traverse. Use its nearest ancestor that every path component lets others search.
function traversableTemporaryRoot() {
  let candidate = tmpdir();
  for (let current = candidate; ; current = dirname(current)) {
    if ((statSync(current).mode & 0o001) === 0) candidate = dirname(current);
    if (current === dirname(current)) return candidate;
  }
}

// Root-run CI keeps node, tsx and the checkout under a private home directory, so an
// unprivileged child needs its own world-readable copy of the runtime and resolver.
function unprivilegedRuntime(t: { after: (fn: () => void) => void }, root: string) {
  const directory = mkdtempSync(join(root, 'propr-vapid-runtime-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  chmodSync(directory, 0o755);
  const executable = join(directory, 'node');
  try { linkSync(process.execPath, executable); } catch { copyFileSync(process.execPath, executable); }
  chmodSync(executable, 0o755);
  writeFileSync(join(directory, 'package.json'), '{"type":"module"}', { mode: 0o644 });
  for (const name of ['instanceWebPushConfiguration', 'webPushConfiguration']) {
    const source = readFileSync(join(SERVICES, `${name}.ts`), 'utf8');
    writeFileSync(join(directory, `${name}.js`), stripTypeScriptTypes(source), { mode: 0o644 });
  }
  return { directory, executable };
}

function child(environment: NodeJS.ProcessEnv, unprivileged?: { uid: number; directory: string; executable: string }): Promise<string> {
  return new Promise((resolve, reject) => {
    const resolver = unprivileged ? './instanceWebPushConfiguration.js' : './packages/api/services/instanceWebPushConfiguration.ts';
    const script = `import { resolveInstanceWebPushConfiguration as resolve } from '${resolver}';
      const result = resolve(JSON.parse(process.argv[1]));
      process.stdout.write(JSON.stringify(result.configured ? { publicKey: result.publicKey } : result));`;
    const args = [...(unprivileged ? [] : ['--import', 'tsx']), '--input-type=module', '-e', script, JSON.stringify(environment)];
    const processChild = unprivileged
      ? spawn(unprivileged.executable, args, { uid: unprivileged.uid, gid: unprivileged.uid, cwd: unprivileged.directory, stdio: ['ignore', 'pipe', 'pipe'] })
      : spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    processChild.stdout.on('data', data => { output += data; });
    processChild.stderr.resume(); // Never relay raw child errors that might contain secret material.
    processChild.on('error', reject);
    processChild.on('close', code => code === 0 ? resolve(output) : reject(new Error('isolated resolver child failed')));
  });
}

test('independent concurrent processes and recreated processes converge on one complete identity', async t => {
  const { environment, filename } = fixture(t);
  const results = await Promise.all(Array.from({ length: 8 }, () => child(environment)));
  assert.equal(new Set(results).size, 1);
  assert.ok(JSON.parse(results[0]).publicKey);
  assert.equal(await child(environment), results[0]);
  assert.equal(JSON.parse(readFileSync(filename, 'utf8')).publicKey, JSON.parse(results[0]).publicKey);
});

test('unwritable mount fails safely; retry after permissions repair succeeds', async t => {
  // Drop root in the child so this verifies real EACCES even in root-run CI. The mount
  // and runtime must be reachable, so only the 0555 mount itself can deny the write.
  const root = process.getuid?.() === 0 ? traversableTemporaryRoot() : undefined;
  const { environment, directory } = fixture(t, root);
  const unprivileged = root ? { uid: 65534, ...unprivilegedRuntime(t, root) } : undefined;
  chmodSync(directory, 0o555);
  try {
    assert.deepEqual(JSON.parse(await child(environment, unprivileged)),
      { configured: false, issue: 'storage_unavailable' });
  } finally { chmodSync(directory, 0o700); }
  assert.deepEqual(readdirSync(directory), []);
  assert.ok(resolveInstanceWebPushConfiguration(environment).configured);
});
