import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { _electron as electron } from 'playwright';
import { accounts, createTwoAccountFixture } from './two-account-http-fixture.mjs';
import { TASK_UPDATE } from '@propr/shared';

const directory = await mkdtemp(join(tmpdir(), 'propr-native-accounts-'));
const fixture = await createTwoAccountFixture();
let application;
const root = resolve(import.meta.dirname, '../../..');
const entry = name => join(import.meta.dirname, name);
const launch = async () => {
  application = await electron.launch({ args: ['--no-sandbox', ...(process.platform === 'linux' && !process.env.DISPLAY ? ['--ozone-platform=headless'] : []), join(directory, 'main.cjs')],
    env: { ...process.env, PROPR_ACCOUNT_SMOKE_DIRECTORY: directory, PROPR_ACCOUNT_SMOKE_ENDPOINT: fixture.endpoint }, timeout: 30_000 });
  const page = await application.firstWindow();
  await page.waitForFunction(() => Boolean(window.accountSmoke));
  return page;
};
const wait = async predicate => {
  const deadline = Date.now() + 10_000;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for native account fixture');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
};
try {
  await build({ entryPoints: [entry('two-account-electron-main.ts')], bundle: true, platform: 'node', format: 'cjs',
    external: ['electron'], outfile: join(directory, 'main.cjs') });
  await build({ entryPoints: [join(root, 'apps/desktop/src/preload.ts')], bundle: true,
    platform: 'node', format: 'cjs', external: ['electron'], outfile: join(directory, 'preload.cjs') });
  await build({ entryPoints: [entry('two-account-electron-renderer.tsx')], bundle: true,
    platform: 'browser', format: 'iife', outfile: join(directory, 'renderer.js'),
    define: { __PROPR_DESKTOP__: 'true', __APP_VERSION__: '"synthetic"', 'import.meta.env': '{}', 'process.env.NODE_ENV': '"production"' } });
  await writeFile(join(directory, 'index.html'), '<!doctype html><div id="root"></div><script src="renderer.js"></script>');
  let page = await launch();
  const a = { id: 'account-a', label: 'Team A', apiBaseUrl: fixture.endpoint };
  const b = { ...a, id: 'account-b', label: 'Team B' };
  for (const [index, profile] of [a, b].entries()) {
    fixture.account(accounts[index]);
    assert.deepEqual(await page.evaluate(p => window.accountSmoke.pair(p), profile), { paired: true });
  }
  const tokenA = [...fixture.users].find(([, account]) => account.id === '101')[0];
  const tokenB = [...fixture.users].find(([, account]) => account.id === '202')[0];
  assert.notEqual(tokenA, tokenB);
  const scopeA = await page.evaluate(p => window.accountSmoke.activate(p), a);
  await wait(() => fixture.io.sockets.sockets.size === 1);
  const socketA = [...fixture.io.sockets.sockets.values()][0];
  socketA.emit(TASK_UPDATE, accounts[0]);
  await page.waitForFunction(() => window.accountSmoke.events.length === 1);
  await page.evaluate(() => { window.accountSmoke.events.length = 0; return window.accountSmoke.delay(); });
  await wait(() => fixture.delayed.size === 2);
  await page.evaluate(p => window.accountSmoke.activate(p), b);
  fixture.release(); socketA.emit(TASK_UPDATE, accounts[0]);
  assert.deepEqual(await page.evaluate(() => window.accountSmoke.settle()), ['rejected', 'rejected', 'rejected']);
  assert.equal(await page.evaluate(s => window.proprDesktop.auth.logout({ profileId: s.profileId, transportScope: s.transportScope }).then(() => 'accepted', () => 'rejected'), scopeA), 'rejected');
  await wait(() => [...fixture.io.sockets.sockets.values()].some(s => s.data.account.id === '202'));
  fixture.io.emit(TASK_UPDATE, accounts[1]);
  await page.waitForFunction(() => window.accountSmoke.events.length > 0);
  assert.deepEqual(await page.evaluate(() => window.accountSmoke.events), [accounts[1]]);
  assert.deepEqual(await page.evaluate(() => window.accountSmoke.current()), accounts[1]);
  fixture.offline(true);
  await page.evaluate(() => window.accountSmoke.logout());
  assert.deepEqual(await page.evaluate(() => window.accountSmoke.state()), { active: null, logoutEvents: 1, errors: [] });
  const snapshot = await application.evaluate(() => globalThis.accountSmoke.snapshot());
  assert.equal(snapshot.activeProfileId, null);
  assert.deepEqual(snapshot.credentialPresent, [true, false]);
  assert.equal(snapshot.pendingRevocations, 1);
  await application.close(); application = undefined;
  page = await launch();
  assert.equal((await page.evaluate(() => window.proprDesktop.profiles.list())).activeProfileId, null);
  assert.equal(await page.evaluate(() => window.accountSmoke.current().then(() => 'accepted', () => 'rejected')), 'rejected');
  fixture.offline(false);
  await page.evaluate(p => window.accountSmoke.activate(p), a);
  assert.deepEqual(await page.evaluate(() => window.accountSmoke.current()), accounts[0]);
  fixture.account(accounts[0]);
  assert.deepEqual(await page.evaluate(p => window.accountSmoke.pair(p), b), { paired: false, code: 'ACCOUNT_MISMATCH' });
  await wait(() => fixture.revoked.has(tokenB));
  assert.equal(fixture.revoked.has(tokenA), false);
  const final = await application.evaluate(() => globalThis.accountSmoke.snapshot());
  assert.deepEqual(final.profiles.map(p => p.account.id), ['101', '202']);
  assert.deepEqual(final.credentialPresent, [true, false]);
  assert.deepEqual(await page.evaluate(() => window.accountSmoke.current()), accounts[0]);
  console.log('PASS native Electron two-account regression (production IPC, preload, HTTP/socket boundary and renderer; synthetic approval/storage).');
} finally {
  await application?.close(); await fixture.close(); await rm(directory, { recursive: true, force: true });
}
