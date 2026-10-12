import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { ACCOUNT, RESULTS, SmokeFailure, assertAccount, assertRuntime, classifyBrowserUrl,
  resultRecord, runJourney, validateConfig, assertMetadataAccess, verifyInstalled } from './live-github-smoke.mjs';
import { fixtureDriver } from './live-github-smoke-fixture.mjs';

const config = { apiOrigin: 'https://staging.propr.dev', sourceRevision: 'a'.repeat(40),
  rpmSha256: 'b'.repeat(64), arch: 'x64', rpmPath: '/private/artifact.rpm', stateRoot: '/var/lib/propr-desktop-live/state' };
const runtime = { git_sha: config.sourceRevision,
  images: { app: `propr/app:${config.sourceRevision}@sha256:${'c'.repeat(64)}`,
    ui: `propr/ui:${config.sourceRevision}@sha256:${'d'.repeat(64)}` },
  desktopRuntime: { schemaVersion: 1, distribution: 'published', sourceRevision: config.sourceRevision,
    apiCompatibility: '2026-09-01', desktopAuthenticationProtocol: 2 } };
const rejectsAs = result => error => error instanceof SmokeFailure && error.result === result;

test('fixtures complete every production journey stage without credentials', async () => {
  const calls = [];
  await runJourney(fixtureDriver({ calls }));
  assert.deepEqual(calls, ['preflight', 'startPairing', 'browserSignIn', 'browserAccount', 'approve',
    'confirmedAccount', 'connect', 'connectedAccount', 'repositoryUsable']);
});
test('wrong browser account stops before approval and repository use', async () => {
  const calls = [];
  await assert.rejects(runJourney(fixtureDriver({ username: 'integry', calls })), rejectsAs('account_mismatch'));
  assert.equal(calls.includes('approve'), false);
  for (const name of ['', 'PROPR-ULTRAFIX', null, 'propr-ultrafix ']) assert.throws(() => assertAccount(name), rejectsAs('account_mismatch'));
});
test('native and connected identity mismatches refuse further work', async () => {
  for (const step of ['confirmedAccount', 'connectedAccount']) {
    const calls = [];
    const driver = fixtureDriver({ calls });
    driver[step] = async () => 'integry';
    await assert.rejects(runJourney(driver), rejectsAs('account_mismatch'));
    assert.equal(calls.includes('repositoryUsable'), false);
    if (step === 'confirmedAccount') assert.equal(calls.includes('connect'), false);
  }
});
test('all result categories stay distinct and no raw errors enter output', async () => {
  for (const result of RESULTS.filter(value => value !== 'passed')) {
    const driver = fixtureDriver({ failure: { step: 'browserSignIn', result } });
    let caught;
    try { await runJourney(driver); } catch (error) { caught = error; }
    assert.equal(resultRecord(caught).result, result);
  }
  const secrets = 'ghp_SENTINEL cookie device-code https://approval.invalid/secret /private/browser';
  assert.deepEqual(resultRecord(new Error(secrets)), { schemaVersion: 1, mode: 'live', result: 'app_pairing_failed' });
  const error = new SmokeFailure('reauthorization_required');
  error.message = secrets; error.stack = secrets; error.cookies = secrets;
  assert.equal(JSON.stringify(resultRecord(error)).includes('SENTINEL'), false);
});
test('production, alternate origins, URL credentials, and unfrozen identities rejected', () => {
  assert.equal(validateConfig(config), config);
  for (const apiOrigin of ['https://propr.dev', 'https://api.propr.dev', 'https://preview.propr.dev.evil.test',
    'http://staging.propr.dev', 'https://staging.propr.dev/', 'https://user:secret@staging.propr.dev', 'https://staging.propr.dev/path']) {
    assert.throws(() => validateConfig({ ...config, apiOrigin }), rejectsAs('configuration_failed'));
  }
  assert.throws(() => validateConfig({ ...config, sourceRevision: 'main' }), rejectsAs('configuration_failed'));
  assert.throws(() => validateConfig({ ...config, rpmSha256: 'latest' }), rejectsAs('configuration_failed'));
});
test('runtime/source and image revision binding fail closed', () => {
  assertRuntime(runtime, config);
  assert.throws(() => assertRuntime(runtime, { ...config, sourceRevision: 'e'.repeat(40) }), rejectsAs('runtime_source_mismatch'));
  assert.throws(() => assertRuntime({ ...runtime, images: { ...runtime.images, app: 'propr/app:latest' } }, config), rejectsAs('runtime_source_mismatch'));
});
test('provider recovery and fresh authorization stop safely', () => {
  for (const path of ['/login', '/sessions/two-factor', '/login/device', '/settings/connections', '/captcha']) {
    assert.throws(() => classifyBrowserUrl(`https://github.com${path}`, config.apiOrigin), rejectsAs('reauthorization_required'));
  }
  classifyBrowserUrl('https://github.com/login/oauth/authorize?secret=SENTINEL', config.apiOrigin);
  classifyBrowserUrl(`${config.apiOrigin}/desktop/pair?secret=SENTINEL`, config.apiOrigin);
  assert.throws(() => classifyBrowserUrl('https://api.propr.dev/login', config.apiOrigin), rejectsAs('configuration_failed'));
});
test('public dry-run emits only safe fixture result even with inherited debug and credential environment', () => {
  const stdout = execFileSync(process.execPath, [new URL('./run-live-github-smoke.mjs', import.meta.url).pathname, '--dry-run'], {
    env: { ...process.env, DEBUG: '*', GITHUB_TOKEN: 'ghp_SENTINEL', PWDEBUG: '1' }, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(stdout), { schemaVersion: 1, mode: 'fixture', result: 'passed' });
  assert.equal(stdout.includes('SENTINEL'), false);
});

test('normal profile locations cannot become smoke state', () => {
  for (const stateRoot of ['/home/user/.config', '/home/user/.config/google-chrome', '/tmp/state']) {
    assert.throws(() => validateConfig({ ...config, stateRoot }), rejectsAs('configuration_failed'));
  }
});
test('public command refuses live execution without opt-in and emits no diagnostics', () => {
  let output;
  try {
    execFileSync(process.execPath, [new URL('./run-live-github-smoke.mjs', import.meta.url).pathname], {
      env: { PATH: process.env.PATH, PROPR_DESKTOP_LIVE_CONFIG: '/private/ghp_SENTINEL' }, encoding: 'utf8' });
    assert.fail('live execution must refuse missing opt-in');
  } catch (error) {
    output = error.stdout;
    assert.equal(error.stderr, '');
  }
  assert.deepEqual(JSON.parse(output), { schemaVersion: 1, mode: 'live', result: 'configuration_failed' });
  assert.equal(output.includes('SENTINEL'), false);
});

test('live workflow stays opt-in, main-only, nonblocking and publishes no session artifacts', () => {
  const workflow = readFileSync(new URL('../../../.github/workflows/desktop-live-github-smoke.yml', import.meta.url), 'utf8');
  assert.match(workflow, /github\.ref == 'refs\/heads\/main' && vars\.PROPR_DESKTOP_LIVE_GITHUB_SMOKE_ENABLED == '1'/);
  assert.match(workflow, /runs-on: \[self-hosted, linux, propr-desktop-live-github\]/);
  assert.match(workflow, /continue-on-error: true/);
  assert.doesNotMatch(workflow, /upload-artifact|secrets\./);
  for (const name of ['desktop-linux-preview.yml', 'desktop-linux-signed-preview.yml']) {
    const release = readFileSync(new URL(`../../../.github/workflows/${name}`, import.meta.url), 'utf8');
    assert.doesNotMatch(release, /needs:.*(?:live-github|live-smoke)/);
  }
});

test('server GitHub grant expiry differs from repository permissions and transient failures', () => {
  for (const code of ['GITHUB_AUTHORIZATION_REQUIRED', 'GITHUB_REAUTH_REQUIRED', 'TOKEN_EXPIRED']) {
    assert.throws(() => assertMetadataAccess({ status: 403, code }), rejectsAs('reauthorization_required'));
  }
  for (const response of [{ status: 403 }, { status: 404, code: 'REPOSITORY_NOT_ACCESSIBLE' },
    { status: 503, code: 'GITHUB_AUTHORIZATION_UNAVAILABLE' }, { status: 401, code: 'TOKEN_REFRESHED' }]) {
    assert.throws(() => assertMetadataAccess(response), rejectsAs('repository_access_failed'));
  }
  assertMetadataAccess({ status: 200 });
  assert.throws(() => classifyBrowserUrl(`${config.apiOrigin}/login`, config.apiOrigin), rejectsAs('reauthorization_required'));
  assert.throws(() => classifyBrowserUrl(`${config.apiOrigin}/login?error=oauth_state_mismatch`, config.apiOrigin), rejectsAs('app_pairing_failed'));
});

test('missing exact RPM is a runtime binding failure, never a pairing regression', async () => {
  if (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch)) return;
  await assert.rejects(verifyInstalled({ ...config, arch: process.arch,
    rpmPath: '/nonexistent-propr-live-rpm/ghp_SENTINEL.rpm' }), rejectsAs('runtime_source_mismatch'));
});
