import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import {
  SignedRpmAcceptanceFailure, boundedDiagnostic, runAcceptancePhase, withCleanupFailures,
} from './signed-rpm-acceptance-diagnostics.mjs';
import { runSignedInstalledRpmAcceptance } from './run-signed-installed-rpm-acceptance.mjs';
import { SIGNED_RPM_ACCEPTANCE_CHECKS } from './signed-rpm-acceptance-evidence.mjs';

const SECRET = 'sentinel-secret-7f3a9c';
const node = process.execPath;
const linuxX64 = process.platform === 'linux' && process.arch === 'x64';

// Public surfaces: the error message, its structured diagnostic and anything Node would print for it.
const assertPrivate = error => {
  assert.ok(error instanceof SignedRpmAcceptanceFailure, inspect(error));
  for (const surface of [error.message, JSON.stringify(error.diagnostic), inspect(error)]) {
    assert.doesNotMatch(surface, new RegExp(SECRET));
    assert.doesNotMatch(surface, /ghp_|BEGIN PGP|\/tmp\/|propr-signed-rpm-[0-9a-f]/);
  }
  assert.equal(error.cause, undefined);
  return error.diagnostic;
};

const failure = async (promise) => assertPrivate(await promise.then(() => assert.fail('expected failure'), error => error));
const noisy = (body) => ['-e', `console.log(process.argv[1]); console.error(process.argv[1], JSON.stringify(process.env)); ${body}`,
  `${SECRET} ghp_${SECRET}`];

test('subprocess exit, signal, timeout and spawn failures are classified without child output', async () => {
  process.env.PROPR_SIGNED_RPM_TEST_SECRET = SECRET;
  try {
    assert.deepEqual(await failure(runAcceptancePhase(node, noisy('process.exit(23)'), { phase: 'image-build' })),
      { phase: 'image-build', outcome: 'exit', exitCode: 23 });
    if (process.platform !== 'win32') {
      assert.deepEqual(await failure(runAcceptancePhase(node, noisy("process.kill(process.pid, 'SIGTERM'); setInterval(() => {}, 1000)"),
        { phase: 'network-create' })), { phase: 'network-create', outcome: 'signal', signal: 'SIGTERM' });
    }
    assert.deepEqual(await failure(runAcceptancePhase(node, noisy('setInterval(() => {}, 1000)'),
      { phase: 'installed-acceptance', timeout: 300 })), { phase: 'installed-acceptance', outcome: 'timeout' });
    assert.deepEqual(await failure(runAcceptancePhase(join(tmpdir(), `${SECRET}-missing-docker`), [SECRET], { phase: 'docker-info' })),
      { phase: 'docker-info', outcome: 'spawn', spawnError: 'ENOENT' });
    const allowed = await runAcceptancePhase(node, noisy('process.exit(4)'), { phase: 'image-cleanup', allowFailure: true });
    assert.equal(allowed.code, 4);
  } finally {
    delete process.env.PROPR_SIGNED_RPM_TEST_SECRET;
  }
});

test('container stage markers are recognized only as complete allowlisted lines', async () => {
  const script = `
    const out = text => new Promise(done => process.stdout.write(text, done));
    await out('PROPR_RPM_ACCEPTANCE_STAGE=key-trust\\n');
    await out('PROPR_RPM_ACCEPTANCE_STA'); await out('GE=package-install\\r\\n');
    await out('PROPR_RPM_ACCEPTANCE_STAGE=${SECRET}\\n');
    await out('x PROPR_RPM_ACCEPTANCE_STAGE=post-verify\\n');
    await out('${'y'.repeat(200)}'); await out('PROPR_RPM_ACCEPTANCE_STAGE=evidence-export\\n');
    process.exit(7);`;
  const args = ['--input-type=module', '-e', script];
  assert.deepEqual(await failure(runAcceptancePhase(node, args, { phase: 'installed-acceptance', trackStages: true })),
    { phase: 'installed-acceptance', outcome: 'exit', exitCode: 7, stage: 'package-install' });
  assert.deepEqual(await failure(runAcceptancePhase(node, args, { phase: 'image-build' })),
    { phase: 'image-build', outcome: 'exit', exitCode: 7 }, 'only the installed run reports container stages');
});

test('diagnostics are rebuilt from allowlisted fields and keep the primary failure first', () => {
  assert.deepEqual(boundedDiagnostic({ phase: SECRET, outcome: SECRET, exitCode: 900, signal: SECRET, spawnError: `${SECRET}`, stage: SECRET, extra: SECRET }),
    { phase: 'unknown', outcome: 'error', spawnError: 'unknown' });
  const combined = withCleanupFailures(new SignedRpmAcceptanceFailure({ phase: 'installed-acceptance', outcome: 'exit', exitCode: 1 }),
    [{ phase: 'container-cleanup', outcome: 'exit', exitCode: 125 }]);
  assert.deepEqual(assertPrivate(combined), { phase: 'installed-acceptance', outcome: 'exit', exitCode: 1,
    cleanup: [{ phase: 'container-cleanup', outcome: 'exit', exitCode: 125 }] });
  assert.match(combined.message, /^Signed installed RPM acceptance failed; no success evidence emitted \[phase=installed-acceptance outcome=exit exitCode=1\]; owned cleanup also failed \[phase=container-cleanup outcome=exit exitCode=125\]$/);
  assert.deepEqual(withCleanupFailures(new Error(`${SECRET} /tmp/x`), [{ phase: 'image-cleanup', outcome: 'timeout' }]).diagnostic,
    { phase: 'unknown', outcome: 'error', cleanup: [{ phase: 'image-cleanup', outcome: 'timeout' }] });
});

// A fake Docker CLI that echoes secret-bearing arguments/environment on every stream and fails on request.
const fakeDocker = `#!/usr/bin/env node
const { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const scenario = JSON.parse(readFileSync(join(__dirname, 'scenario.json'), 'utf8'));
const state = join(__dirname, 'state.json');
const saved = existsSync(state) ? JSON.parse(readFileSync(state, 'utf8')) : {};
const save = () => writeFileSync(state, JSON.stringify(saved));
const args = process.argv.slice(2);
const key = ['network', 'image'].includes(args[0]) ? args.slice(0, 2).join(' ') : args[0];
appendFileSync(join(__dirname, 'calls.log'), key + '\\n');
const spec = scenario[key] ?? {};
const noise = scenario.secret + ' ' + args.join(' ') + ' ' + JSON.stringify(process.env) + '\\n';
process.stderr.write(noise);
if (!['info', 'inspect', 'network inspect'].includes(key)) process.stdout.write(noise);
for (const stage of spec.stages ?? []) process.stdout.write('PROPR_RPM_ACCEPTANCE_STAGE=' + stage + '\\n');
const label = args[args.indexOf('--label') + 1];
if (key === 'info') process.stdout.write('linux/amd64\\n');
if (key === 'network create' && spec.exit === undefined) { saved.network = label.split('=')[1]; save(); }
if (key === 'network rm' && spec.exit === undefined) { delete saved.network; save(); }
if (key === 'network inspect' && !saved.network) process.exit(1);
if (key === 'network inspect') process.stdout.write((spec.owner ?? saved.network) + '\\n');
if (key === 'run') {
  saved.container = label.split('=')[1];
  saved.workspace = args.find(arg => arg.endsWith(',dst=/evidence')).split(',')[1].slice(4).replace(/\\/evidence$/, '');
  save();
  if (spec.mutate) appendFileSync(args.find(arg => arg.endsWith(',dst=/input/preview.rpm,readonly')).split(',')[1].slice(4), 'x');
  if (spec.exit === undefined) {
    const evidence = join(saved.workspace, 'evidence');
    const checks = Object.fromEntries(scenario.checks.map(key => [key, true]));
    writeFileSync(join(evidence, 'browser.json'), spec.browser ?? JSON.stringify(checks));
    for (const name of ['pairing-evidence', 'desktop-acceptance-artifacts']) {
      mkdirSync(join(evidence, name));
      writeFileSync(join(evidence, name, 'result.json'), '{}');
    }
  }
}
if (key === 'inspect') {
  if (!spec.present) process.exit(1);
  process.stdout.write(saved.container + '\\n');
}
if (spec.signal) process.kill(process.pid, spec.signal);
process.exitCode = spec.exit ?? 0;
`;

const harness = async (t, scenario) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'signed-rpm-diagnostics-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bin = join(directory, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'docker'), fakeDocker);
  await chmod(join(bin, 'docker'), 0o755);
  await writeFile(join(bin, 'scenario.json'), JSON.stringify({ ...scenario, secret: SECRET, checks: SIGNED_RPM_ACCEPTANCE_CHECKS }));
  // The artifact path itself carries a sentinel to prove arguments never reach diagnostics.
  const rpm = join(directory, `${SECRET}-ProPR-Desktop-linux-x64.rpm`);
  await writeFile(join(directory, 'calls.log'), '');
  await writeFile(rpm, 'synthetic signed rpm bytes');
  const output = join(directory, 'output');
  const options = {
    rpm, outputDirectory: output, sourceRevision: 'a'.repeat(40), signingRunId: '42',
    identity: { fingerprint: 'B'.repeat(40), publicKey: `-----BEGIN PGP PUBLIC KEY BLOCK-----\n${SECRET}\n` },
  };
  const verified = [];
  const execute = (dependencies = {}) => runSignedInstalledRpmAcceptance(options, {
    docker: join(bin, 'docker'), verify: async ({ identity }) => { verified.push(identity.fingerprint); },
    prepareContext: async ({ context }) => { await mkdir(context, { recursive: true }); }, ...dependencies,
  });
  const calls = async () => (await readFile(join(bin, 'calls.log'), 'utf8')).trim().split('\n');
  const state = async () => existsSync(join(bin, 'state.json')) ? JSON.parse(await readFile(join(bin, 'state.json'), 'utf8')) : {};
  return { execute, calls, state, output, verified };
};

const fullFlow = { skip: linuxX64 ? false : 'Signed RPM acceptance runs only on native Linux x64' };
const withOptIn = async callback => {
  const previous = process.env.PROPR_DESKTOP_REAL_LINUX_PACKAGE_ACCEPTANCE;
  process.env.PROPR_DESKTOP_REAL_LINUX_PACKAGE_ACCEPTANCE = '1';
  process.env.PROPR_SIGNED_RPM_TEST_SECRET = SECRET;
  try { return await callback(); }
  finally {
    if (previous === undefined) delete process.env.PROPR_DESKTOP_REAL_LINUX_PACKAGE_ACCEPTANCE;
    else process.env.PROPR_DESKTOP_REAL_LINUX_PACKAGE_ACCEPTANCE = previous;
    delete process.env.PROPR_SIGNED_RPM_TEST_SECRET;
  }
};
const assertNoEvidence = output => assert.equal(existsSync(join(output, 'signed-rpm-acceptance.json')), false);
const cleanupCalls = ['inspect', 'network inspect', 'network rm', 'image rm'];

test('a complete fake run still emits strict evidence after owned cleanup', fullFlow, t => withOptIn(async () => {
  const run = await harness(t, {});
  const evidence = await run.execute();
  assert.equal(evidence.status, 'passed');
  assert.deepEqual(run.verified, ['B'.repeat(40)]);
  assert.deepEqual(JSON.parse(await readFile(join(run.output, 'signed-rpm-acceptance.json'), 'utf8')), evidence);
  assert.deepEqual(await run.calls(), ['info', 'build', 'network create', 'run', ...cleanupCalls]);
  assert.equal(existsSync((await run.state()).workspace), false, 'private workspace is removed');
}));

for (const [label, scenario, expected, calls] of [
  ['docker CLI spawn', null, { phase: 'docker-info', outcome: 'spawn', spawnError: 'ENOENT' }, []],
  ['image build', { build: { exit: 17 } }, { phase: 'image-build', outcome: 'exit', exitCode: 17 },
    ['info', 'build', 'inspect', 'network inspect', 'image rm']],
  ['isolated network setup', { 'network create': { exit: 1 } }, { phase: 'network-create', outcome: 'exit', exitCode: 1 },
    ['info', 'build', 'network create', 'inspect', 'network inspect', 'image rm']],
  ['installed package execution', { run: { exit: 1, stages: ['key-trust', 'package-install'] } },
    { phase: 'installed-acceptance', outcome: 'exit', exitCode: 1, stage: 'package-install' },
    ['info', 'build', 'network create', 'run', ...cleanupCalls]],
  ['installed browser execution signal', { run: { signal: 'SIGKILL', stages: ['browser-acceptance'] } },
    { phase: 'installed-acceptance', outcome: 'signal', signal: 'SIGKILL', stage: 'browser-acceptance' },
    ['info', 'build', 'network create', 'run', ...cleanupCalls]],
  ['owned cleanup only', { inspect: { present: true }, rm: { exit: 125 } },
    { phase: 'container-cleanup', outcome: 'exit', exitCode: 125 },
    ['info', 'build', 'network create', 'run', 'inspect', 'rm', 'network inspect', 'network rm', 'image rm']],
]) {
  test(`${label} failure names its fixed phase and emits no success evidence`, fullFlow, t => withOptIn(async () => {
    const run = await harness(t, scenario ?? {});
    const dependencies = scenario ? {} : { docker: join(tmpdir(), `${SECRET}-absent`, 'docker') };
    assert.deepEqual(await failure(run.execute(dependencies)), expected);
    assertNoEvidence(run.output);
    if (calls.length) assert.deepEqual(await run.calls(), calls);
    const { workspace } = await run.state();
    if (workspace) assert.equal(existsSync(workspace), false, 'private workspace is removed');
  }));
}

test('primary acceptance failure survives failing owned cleanup and every cleanup still runs', fullFlow, t => withOptIn(async () => {
  const run = await harness(t, {
    run: { exit: 3, stages: ['signature-verify'] }, inspect: { present: true }, rm: { exit: 1 },
    'network inspect': { owner: SECRET }, 'image rm': { signal: 'SIGTERM' },
  });
  const diagnostic = await failure(run.execute());
  assert.deepEqual(diagnostic, { phase: 'installed-acceptance', outcome: 'exit', exitCode: 3, stage: 'signature-verify',
    cleanup: [{ phase: 'container-cleanup', outcome: 'exit', exitCode: 1 },
      { phase: 'network-cleanup', outcome: 'ownership-refused' },
      { phase: 'image-cleanup', outcome: 'signal', signal: 'SIGTERM' }] });
  // A network it does not own is never removed; the image and workspace cleanup still run.
  assert.deepEqual(await run.calls(), ['info', 'build', 'network create', 'run', 'inspect', 'rm', 'network inspect', 'image rm']);
  assert.equal(existsSync((await run.state()).workspace), false);
  assertNoEvidence(run.output);
}));

test('in-process failures are classified without echoing paths or container-produced content', fullFlow, t => withOptIn(async () => {
  const failing = await harness(t, {});
  assert.deepEqual(await failure(failing.execute({ prepareContext: async ({ context }) => {
    throw new Error(`${SECRET} missing ${context}`);
  } })), { phase: 'context-preparation', outcome: 'error' });
  for (const [run, expected] of [
    [{ browser: `{"browserApproval": "${SECRET}"` }, { phase: 'evidence-collection', outcome: 'error' }],
    [{ browser: JSON.stringify({ browserApproval: true }) }, { phase: 'evidence-collection', outcome: 'evidence-invalid' }],
    [{ mutate: true }, { phase: 'evidence-collection', outcome: 'artifact-changed' }],
  ]) {
    const flow = await harness(t, { run });
    assert.deepEqual(await failure(flow.execute()), expected);
    assertNoEvidence(flow.output);
    assert.equal(existsSync((await flow.state()).workspace), false);
  }
}));
