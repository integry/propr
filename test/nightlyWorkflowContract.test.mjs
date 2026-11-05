import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';
import { planRun, unitKey } from '../scripts/run-test-suite.mjs';
import { readNightlyChecks, classifyNightly, nightlyArtifactName } from '../apps/desktop/scripts/nightly-native-bundle.mjs';
import { collectFailures, nightlyOutcome } from '../scripts/nightly-health-issue.mjs';

const workflow = parse(readFileSync(new URL('../.github/workflows/test-nightly.yml', import.meta.url), 'utf8'));
const jobs = workflow.jobs;
const full = jobs['full-tests'];
const live = jobs['e2e-tests'];
const step = (job, id) => job.steps.find(s => s.id === id);
function assertClockDeadline(ms, before, after) {
  // date +%s truncates a sample taken during the child process, not at before.
  assert.ok(Number.isSafeInteger(ms) && ms % 1000 === 0);
  assert.ok(ms >= Math.floor(before / 1000) * 1000 + 110 * 60_000);
  assert.ok(ms <= Math.floor(after / 1000) * 1000 + 110 * 60_000);
}
// Evaluate this workflow's actual expressions with Actions-style status functions.
function evaluate(expression, { needs = {}, steps = {}, success = true, cancelled = false } = {}) {
  const js = expression.replace(/^\$\{\{\s*|\s*\}\}$/g, '')
    .replace(/needs\.([\w-]+)/g, (_, id) => `needs[${JSON.stringify(id)}]`);
  return Function('needs', 'steps', 'success', 'cancelled', `return (${js});`)(needs, steps, () => success, () => cancelled);
}
const green = () => ({
  'full-tests': { result: 'success', outputs: { full_tests: 'success' } },
  'e2e-tests': { result: 'success', outputs: { e2e_config: 'success', e2e_tests: 'success' } },
  'native-electron': { result: 'success' },
  'desktop-package': { result: 'success' },
  'desktop-connect': { result: 'success' },
});

test('live execution requires the entire prerequisite job and canonical suite output to succeed', () => {
  assert.deepEqual(live.needs, ['full-tests']);
  for (const result of ['success', 'failure', 'cancelled', 'skipped', '']) {
    for (const outcome of ['success', 'failure', 'cancelled', 'skipped', '']) {
      const needs = { 'full-tests': { result, outputs: { full_tests: outcome } } };
      assert.equal(evaluate(live.if, { needs }), result === 'success' && outcome === 'success');
      assert.equal(evaluate(live.if, { needs, success: false }), false);
    }
  }
  for (const outcome of ['success', 'failure', 'skipped', 'cancelled']) {
    assert.equal(evaluate(step(live, 'e2e_tests').if, { steps: { e2e_config: { outcome } } }), outcome === 'success');
  }
  assert.equal(step(full, 'full_tests').env.PROPR_REQUIRE_REDIS_INTEGRATION, '1');
  assert.ok(full.steps.find(s => s.id === 'redis').run.endsWith(' start'));
  assert.equal(full.steps.find(s => s.name === 'Stop isolated Redis').if, 'always()');
  assert.equal(full.steps.filter(s => s.run?.includes('npm run test:full:prepared')).length, 1);
  assert.ok(!live.steps.some(s => /test:full|ci-redis|setup.sh/.test(s.run ?? '')));
  for (const job of [full, live]) {
    for (const [id, expression] of Object.entries(job.outputs)) {
      for (const outcome of ['success', 'failure', 'skipped', 'cancelled']) {
        assert.equal(evaluate(expression, { steps: { [id]: { outcome } } }), outcome);
      }
    }
  }
});

test('each clock is bounded independently; pipeline failures preserve status and terminal output', () => {
  const root = mkdtempSync(join(tmpdir(), 'nightly-contract-'));
  try {
    // Execute the actual steps under the explicit Actions bash shell with a fake npm.
    writeFileSync(join(root, 'npm'), '#!/bin/sh\necho "terminal TAP: failed"\nexit 7\n', { mode: 0o755 });
    for (const [job, id, filename, deadline] of [[full, 'full_tests', 'test_output.txt', 'PROPR_FULL_DEADLINE_SECONDS'], [live, 'e2e_tests', 'e2e_output.txt', 'PROPR_E2E_DEADLINE_EPOCH_MS']]) {
      const envFile = join(root, 'env');
      writeFileSync(envFile, '');
      const before = Date.now();
      const clock = spawnSync('bash', ['-e', '-c', job.steps[0].run], { env: { ...process.env, GITHUB_ENV: envFile } });
      const after = Date.now();
      assert.equal(clock.status, 0);
      const value = readFileSync(envFile, 'utf8').trim().split('=')[1];
      const ms = Number(value) * (deadline.endsWith('SECONDS') ? 1000 : 1);
      assertClockDeadline(ms, before, after);
      assert.equal(job['timeout-minutes'], 120);
      const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', step(job, id).run], {
        cwd: root, encoding: 'utf8', env: { ...process.env, PATH: `${root}:${process.env.PATH}`, [deadline]: value, GITHUB_OUTPUT: join(root, 'output') },
      });
      assert.equal(result.status, 7, result.stderr);
      assert.match(readFileSync(join(root, filename), 'utf8'), /terminal TAP: failed/);
      assert.match(readFileSync(join(root, 'output'), 'utf8'), /result=failure/);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('both clock contracts accept second-boundary samples and reject out-of-bracket deadlines', () => {
  const root = mkdtempSync(join(tmpdir(), 'nightly-clock-boundary-'));
  try {
    writeFileSync(join(root, 'date'), '#!/bin/sh\n[ "$#" -eq 1 ] && [ "$1" = "+%s" ] || exit 1\nprintf "%s\\n" "$SAMPLE_SECONDS"\n', { mode: 0o755 });
    // Model a spawn spanning 1000.999s to 1001.001s without wall-clock sleeps.
    const before = 1_000_999;
    const after = 1_001_001;
    for (const [job, deadline, scale] of [[full, 'PROPR_FULL_DEADLINE_SECONDS', 1000], [live, 'PROPR_E2E_DEADLINE_EPOCH_MS', 1]]) {
      for (const sampleSeconds of [1000, 1001]) {
        const envFile = join(root, 'env');
        writeFileSync(envFile, '');
        const clock = spawnSync('bash', ['-e', '-c', job.steps[0].run], {
          encoding: 'utf8', env: { ...process.env, PATH: `${root}:${process.env.PATH}`, SAMPLE_SECONDS: String(sampleSeconds), GITHUB_ENV: envFile },
        });
        assert.equal(clock.status, 0, clock.stderr);
        const ms = (sampleSeconds + 110 * 60) * 1000;
        assert.equal(readFileSync(envFile, 'utf8').trim(), `${deadline}=${ms / scale}`);
        assertClockDeadline(ms, before, after);
        if (sampleSeconds === 1001) {
          assert.ok(ms - before > 110 * 60_000, 'the old upper bound rejects this valid boundary sample');
        }
      }
    }
    assert.throws(() => assertClockDeadline((999 + 110 * 60) * 1000, before, after), assert.AssertionError);
    assert.throws(() => assertClockDeadline((1002 + 110 * 60) * 1000, before, after), assert.AssertionError);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('nightly configuration rejects task budgets that cannot fit both model phases', () => {
  for (const value of ['1800000', '1500000', '0', '-1', '3600000', 'invalid']) {
    const result = spawnSync('bash', ['-e', '-c', step(live, 'e2e_config').run], {
      env: { ...process.env, PROPR_E2E_MODEL_TASK_TIMEOUT_MS: value, PROPR_E2E_API_URL: 'test', PROPR_E2E_TOKEN: 'test', PROPR_E2E_REPO: 'test' },
    });
    assert.equal(result.status, ['1800000', '1500000'].includes(value) ? 0 : 1);
  }
});

test('both consumers observe both jobs; every missing or non-success result blocks all-checks-passed', () => {
  for (const id of ['desktop-nightly-download', 'nightly-health']) {
    for (const dependency of ['full-tests', 'e2e-tests']) assert.ok(jobs[id].needs.includes(dependency));
  }
  for (const job of ['full-tests', 'e2e-tests']) {
    for (const field of ['result', ...Object.keys(jobs[job].outputs)]) {
      for (const outcome of ['failure', 'cancelled', 'skipped', undefined]) {
        const needs = green();
        if (field === 'result') needs[job].result = outcome;
        else needs[job].outputs[field] = outcome;
        const status = classifyNightly(readNightlyChecks(needs));
        assert.equal(status.releaseValidationCandidate, false);
        assert.match(nightlyArtifactName({ version: '1.0.0', sourceSha: 'a'.repeat(40), runId: 1, runAttempt: 1, nightly: status.nightly }), /packaging-only$/);
        if (field === 'result') assert.equal(nightlyOutcome(needs), outcome === 'failure' ? 'failure' : 'unknown');
      }
    }
  }
  assert.equal(classifyNightly(readNightlyChecks(green())).nightly, 'passed');
});

test('health selects each failed job artifact and falls back to logs for configuration or setup failure', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nightly-diagnostics-'));
  try {
    const suiteNames = JSON.parse(jobs['nightly-health'].steps.at(-1).env.NIGHTLY_SUITE_JOBS);
    const download = jobs['nightly-health'].steps.find(s => s.uses?.startsWith('actions/download-artifact'));
    assert.equal(download.with['merge-multiple'], true);
    for (const [id, name] of Object.entries(suiteNames)) {
      const upload = jobs[id].steps.find(s => s.uses?.startsWith('actions/upload-artifact'));
      assert.ok(upload.with.name.startsWith(download.with.pattern.slice(0, -1)));
      writeFileSync(join(root, upload.with.path), `${id} diagnostic`);
      for (const output of [...Object.keys(jobs[id].outputs), 'setup']) {
        const calls = [];
        const github = {
          paginate: async () => [{ id: 1, name, conclusion: 'failure', steps: [] }],
          rest: { actions: { listJobsForWorkflowRunAttempt() {}, downloadJobLogsForWorkflowRun: async () => { calls.push(1); return { data: 'job log failure' }; } } },
        };
        const [failure] = await collectFailures({ github, diagnosticsDir: root, suiteJobs: { [name]: { [output]: 'failure' } } });
        assert.equal(failure.excerpt, ['setup', 'e2e_config'].includes(output) ? 'job log failure' : `${id} diagnostic`);
        assert.equal(calls.length, ['setup', 'e2e_config'].includes(output) ? 1 : 0);
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('canonical full discovery runs each unit once and keeps live tests separate', () => {
  const plan = planRun();
  const keys = plan.units.map(unitKey);
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(keys.some(key => key.includes('nightlyWorkflowContract.test.mjs')));
  assert.ok(!keys.some(key => key.endsWith('/e2e.test.ts')));
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.scripts['test:full:prepared'], 'npm run test:server');
  assert.equal(pkg.scripts['test:server'], 'node scripts/run-test-suite.mjs');
  assert.equal(pkg.scripts['test:e2e'], 'npx tsx --test test/e2e.test.ts');
  for (const job of [full, live]) {
    const outcomes = Object.fromEntries(Object.keys(job.outputs).map(id => [id, { outcome: 'success' }]));
    const gate = job.steps.find(s => s.name === 'Fail Job');
    assert.equal(evaluate(gate.if, { steps: outcomes }), false);
    for (const id of Object.keys(outcomes)) {
      assert.equal(evaluate(gate.if, { steps: { ...outcomes, [id]: { outcome: 'failure' } } }), true);
    }
  }
});
