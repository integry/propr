import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { parse } from 'yaml';
import {
  formatOutputs, planRollout, planSummary, previewReleases, publishedPreviewRelease, releaseTagFromTrigger,
  resolveSource, rolloutOutputs, runtimeReferences,
} from '../scripts/release-rollout-plan.mjs';
import { inspectPublishedRuntime } from '../scripts/preview-runtime-images.mjs';
import { isCurrentReleaseRolloutRun, releaseRolloutWorkflowRef } from '../apps/desktop/scripts/release-rollout-run.mjs';
import { trustedSigningRun } from '../apps/desktop/scripts/linux-preview-release.mjs';

const read = name => parse(readFileSync(`.github/workflows/${name}`, 'utf8'));
const rollout = read('release-rollout.yml');
const rolloutText = readFileSync('.github/workflows/release-rollout.yml', 'utf8');
const called = {
  runtime: read('preview-runtime-images.yml'),
  linux: read('desktop-linux-preview.yml'),
  signed: read('desktop-linux-signed-preview.yml'),
  macos: read('desktop-macos-preview.yml'),
  cli: read('preview-cli-bundle.yml'),
};
const jobs = rollout.jobs;
const SHA = '0c6213a643f316bbe33f2800f858bd9462f83b74';
const OTHER = 'a'.repeat(40);
const digest = character => `sha256:${character.repeat(64)}`;
const fixtures = [];
afterEach(() => { while (fixtures.length) rmSync(fixtures.pop(), { recursive: true, force: true }); });

// Text of every `secrets.<NAME>` reference, per job, in a parsed workflow.
const secretReferences = workflow => Object.fromEntries(Object.entries(workflow.jobs)
  .map(([name, job]) => [name, [...new Set(JSON.stringify(job).match(/secrets\.[A-Z_]+/g) ?? [])].sort()])
  .filter(([, references]) => references.length));
const environments = workflow => Object.fromEntries(Object.entries(workflow.jobs)
  .filter(([, job]) => job.environment).map(([name, job]) => [name, job.environment.name]));

describe('Release Rollout workflow contract', () => {
  test('is dispatched with a release tag or follows a successful Docker Images tag run', () => {
    assert.deepEqual(Object.keys(rollout.on).sort(), ['workflow_dispatch', 'workflow_run']);
    assert.deepEqual(Object.keys(rollout.on.workflow_dispatch.inputs), ['release_tag']);
    assert.deepEqual([rollout.on.workflow_dispatch.inputs.release_tag.required, rollout.on.workflow_dispatch.inputs.release_tag.type],
      [true, 'string']);
    assert.deepEqual(rollout.on.workflow_run, { workflows: ['Docker Images'], types: ['completed'] });
    assert.equal(read('docker-images.yml').name, 'Docker Images', 'workflow_run names the release workflow');
    assert.match(jobs.plan.if, /github\.event_name == 'workflow_dispatch'/);
    assert.match(jobs.plan.if, /github\.event\.workflow_run\.conclusion == 'success'/);
    assert.match(jobs.plan.if, /github\.event\.workflow_run\.event == 'push'/);
    assert.deepEqual(rollout.permissions, { contents: 'read' });
    assert.equal(rollout.concurrency['cancel-in-progress'], false);
  });

  test('runs the chain in order: agent, then app/UI, then Linux draft -> signing -> publication, macOS and the CLI bundle', () => {
    const needs = Object.fromEntries(Object.entries(jobs).map(([name, job]) => [name, [job.needs ?? []].flat()]));
    assert.deepEqual(needs, {
      plan: [],
      'runtime-agent': ['plan'],
      'runtime-app-ui': ['plan', 'runtime-agent'],
      runtime: ['plan', 'runtime-agent', 'runtime-app-ui'],
      'linux-draft': ['plan', 'runtime'],
      'linux-signing': ['plan', 'linux-draft'],
      'linux-publication': ['plan', 'linux-signing'],
      macos: ['plan', 'runtime'],
      'cli-bundle': ['plan', 'runtime'],
      summary: ['plan', 'runtime-agent', 'runtime-app-ui', 'runtime', 'linux-draft', 'linux-signing', 'linux-publication', 'macos', 'cli-bundle'],
      followups: ['plan', 'runtime', 'linux-publication', 'macos', 'cli-bundle', 'summary'],
    });
    // A skipped step (its artefact exists) must not skip the rest; a failure or cancellation must.
    for (const name of ['runtime-app-ui', 'runtime', 'linux-draft', 'linux-signing', 'linux-publication', 'macos', 'cli-bundle']) {
      assert.match(jobs[name].if, /^\$\{\{ !cancelled\(\) && !failure\(\) && /, name);
    }
    assert.equal(jobs['runtime-agent'].if, "needs.plan.outputs.publish_agent == 'true'");
    assert.match(jobs['runtime-app-ui'].if, /needs\.plan\.outputs\.publish_app_ui == 'true'/);
    assert.match(jobs['linux-draft'].if, /needs\.runtime\.result == 'success' && needs\.plan\.outputs\.linux == 'true'/);
    assert.match(jobs['linux-signing'].if, /needs\.linux-draft\.result == 'success'/);
    assert.match(jobs['linux-publication'].if, /needs\.linux-signing\.result == 'success'/);
    assert.match(jobs.macos.if, /needs\.runtime\.result == 'success' && needs\.plan\.outputs\.macos == 'true'/);
    assert.match(jobs['cli-bundle'].if, /needs\.runtime\.result == 'success'/);
  });

  test('calls the existing workflows and passes each output along', () => {
    const source = '${{ needs.plan.outputs.source_revision }}';
    const runtime = image => `\${{ needs.runtime.outputs.runtime_${image}_image }}`;
    const expected = {
      'runtime-agent': ['./.github/workflows/preview-runtime-images.yml', { operation: 'publish-agent', source_revision: source }],
      'runtime-app-ui': ['./.github/workflows/preview-runtime-images.yml', { operation: 'publish', source_revision: source }],
      'linux-draft': ['./.github/workflows/desktop-linux-preview.yml', {
        operation: 'stage-draft', source_revision: source,
        runtime_app_image: runtime('app'), runtime_ui_image: runtime('ui'), runtime_agent_image: runtime('agent'),
      }],
      'linux-signing': ['./.github/workflows/desktop-linux-signed-preview.yml', {
        operation: 'sign-draft', source_revision: source, unsigned_run_id: '${{ github.run_id }}',
      }],
      'linux-publication': ['./.github/workflows/desktop-linux-signed-preview.yml', {
        operation: 'publish-draft', source_revision: source, signing_run_id: '${{ github.run_id }}',
      }],
      macos: ['./.github/workflows/desktop-macos-preview.yml', {
        source_revision: source, runtime_app_image: runtime('app'), runtime_ui_image: runtime('ui'), runtime_agent_image: runtime('agent'),
      }],
      'cli-bundle': ['./.github/workflows/preview-cli-bundle.yml', {
        source_revision: source, app_image: runtime('app'), ui_image: runtime('ui'), agent_image: runtime('agent'),
      }],
    };
    for (const [name, [uses, inputs]] of Object.entries(expected)) {
      assert.equal(jobs[name].uses, uses, name);
      assert.deepEqual(jobs[name].with, inputs, name);
      assert.equal(jobs[name].steps, undefined, `${name} duplicates no job of the called workflow`);
    }
    const merge = jobs.runtime.steps.find(step => step.id === 'runtime');
    assert.deepEqual(merge.env, {
      SOURCE_REVISION: source,
      PUBLISHED_APP_IMAGE: '${{ needs.runtime-app-ui.outputs.runtime_app_image }}',
      PUBLISHED_UI_IMAGE: '${{ needs.runtime-app-ui.outputs.runtime_ui_image }}',
      PUBLISHED_AGENT_IMAGE: '${{ needs.runtime-agent.outputs.runtime_agent_image }}',
      EXISTING_APP_IMAGE: '${{ needs.plan.outputs.runtime_app_image }}',
      EXISTING_UI_IMAGE: '${{ needs.plan.outputs.runtime_ui_image }}',
      EXISTING_AGENT_IMAGE: '${{ needs.plan.outputs.runtime_agent_image }}',
    });
    assert.equal(merge.run, 'node scripts/release-rollout-plan.mjs runtime');
    assert.equal(jobs.plan.steps.at(-1).run, 'node scripts/release-rollout-plan.mjs plan');
  });

  test('every called workflow accepts exactly the inputs it is given and exposes the outputs used', () => {
    const byWorkflow = { runtime: ['runtime-agent', 'runtime-app-ui'], linux: ['linux-draft'],
      signed: ['linux-signing', 'linux-publication'], macos: ['macos'], cli: ['cli-bundle'] };
    for (const [key, callers] of Object.entries(byWorkflow)) {
      const call = called[key].on.workflow_call;
      assert.ok(call, `${key} is callable`);
      assert.ok(called[key].on.workflow_dispatch, `${key} keeps its manual dispatch`);
      const declared = Object.keys(call.inputs);
      for (const caller of callers) {
        for (const input of Object.keys(jobs[caller].with)) assert.ok(declared.includes(input), `${caller}: ${input}`);
        for (const [input, definition] of Object.entries(call.inputs)) {
          if (definition.required) assert.ok(input in jobs[caller].with, `${caller} must pass ${input}`);
        }
      }
      // Manual dispatch inputs and callable inputs share their names.
      assert.deepEqual(declared.sort(), Object.keys(called[key].on.workflow_dispatch.inputs).sort(), key);
    }
    assert.deepEqual(called.runtime.on.workflow_call.outputs, {
      runtime_app_image: { description: called.runtime.on.workflow_call.outputs.runtime_app_image.description,
        value: '${{ jobs.publish.outputs.runtime_app_image }}' },
      runtime_ui_image: { description: called.runtime.on.workflow_call.outputs.runtime_ui_image.description,
        value: '${{ jobs.publish.outputs.runtime_ui_image }}' },
      runtime_agent_image: { description: called.runtime.on.workflow_call.outputs.runtime_agent_image.description,
        value: '${{ jobs.publish-agent.outputs.runtime_agent_image }}' },
    });
  });

  test('keeps every protected environment where it is, introduces no secret and passes each one a called job reads', () => {
    assert.deepEqual(environments(called.runtime), {
      publish: 'desktop-linux-preview-runtime-publication', 'publish-agent': 'desktop-linux-preview-runtime-publication',
    });
    assert.deepEqual(environments(called.linux), {});
    assert.deepEqual(environments(called.signed), {
      sign: 'desktop-linux-rpm-signing', 'publish-draft': 'desktop-linux-preview-publication', 'verify-key': 'desktop-linux-rpm-signing',
    });
    assert.deepEqual(environments(called.macos), { publish: 'desktop-macos-preview-publication' });
    assert.deepEqual(environments(called.cli), {});
    assert.deepEqual(environments(rollout), {}, 'the rollout itself adds no environment and bypasses none');

    // The same jobs read the same secrets as before; callers pass only those.
    assert.deepEqual(secretReferences(called.runtime), {
      publish: ['secrets.DOCKERHUB_TOKEN', 'secrets.DOCKERHUB_USERNAME'],
      'publish-agent': ['secrets.DOCKERHUB_TOKEN', 'secrets.DOCKERHUB_USERNAME'],
    });
    assert.deepEqual(secretReferences(called.signed), {
      sign: ['secrets.PROPR_DESKTOP_RPM_PASSPHRASE', 'secrets.PROPR_DESKTOP_RPM_PRIVATE_KEY'],
      'verify-key': ['secrets.PROPR_DESKTOP_RPM_PASSPHRASE', 'secrets.PROPR_DESKTOP_RPM_PRIVATE_KEY'],
    });
    for (const key of ['linux', 'macos', 'cli']) {
      assert.deepEqual(secretReferences(called[key]), {}, key);
      assert.equal(called[key].on.workflow_call.secrets, undefined, key);
    }
    assert.deepEqual(Object.keys(called.runtime.on.workflow_call.secrets).sort(), ['DOCKERHUB_TOKEN', 'DOCKERHUB_USERNAME']);
    assert.deepEqual(Object.keys(called.signed.on.workflow_call.secrets).sort(), ['PROPR_DESKTOP_RPM_PASSPHRASE', 'PROPR_DESKTOP_RPM_PRIVATE_KEY']);
    const passed = Object.fromEntries(Object.entries(jobs).filter(([, job]) => job.secrets).map(([name, job]) => [name, job.secrets]));
    assert.deepEqual(passed, {
      'runtime-agent': { DOCKERHUB_USERNAME: '${{ secrets.DOCKERHUB_USERNAME }}', DOCKERHUB_TOKEN: '${{ secrets.DOCKERHUB_TOKEN }}' },
      'runtime-app-ui': { DOCKERHUB_USERNAME: '${{ secrets.DOCKERHUB_USERNAME }}', DOCKERHUB_TOKEN: '${{ secrets.DOCKERHUB_TOKEN }}' },
      'linux-signing': {
        PROPR_DESKTOP_RPM_PRIVATE_KEY: '${{ secrets.PROPR_DESKTOP_RPM_PRIVATE_KEY }}',
        PROPR_DESKTOP_RPM_PASSPHRASE: '${{ secrets.PROPR_DESKTOP_RPM_PASSPHRASE }}',
      },
    });
    assert.doesNotMatch(rolloutText, /secrets: inherit/);
    // A called workflow sees only the secrets its caller passes, even those of
    // its own job's environment. Every secret a called job reads must be
    // declared and passed by each call of that workflow, or it reads as empty.
    const calledByPath = {
      './.github/workflows/preview-runtime-images.yml': called.runtime,
      './.github/workflows/desktop-linux-preview.yml': called.linux,
      './.github/workflows/desktop-linux-signed-preview.yml': called.signed,
      './.github/workflows/desktop-macos-preview.yml': called.macos,
      './.github/workflows/preview-cli-bundle.yml': called.cli,
    };
    const calls = Object.entries(jobs).filter(([, job]) => job.uses);
    assert.deepEqual(calls.map(([, job]) => job.uses).sort(), Object.keys(calledByPath).concat(
      './.github/workflows/preview-runtime-images.yml', './.github/workflows/desktop-linux-signed-preview.yml').sort());
    for (const [name, job] of calls) {
      const target = calledByPath[job.uses];
      const operation = job.with?.operation;
      const read = Object.entries(secretReferences(target))
        .filter(([calledJob]) => !operation || JSON.stringify(target.jobs[calledJob].if ?? '').includes(`'${operation}'`))
        .flatMap(([, references]) => references.map(reference => reference.slice('secrets.'.length)));
      for (const secret of new Set(read)) {
        assert.ok(target.on.workflow_call.secrets?.[secret], `${job.uses} declares ${secret}`);
        assert.equal(job.secrets?.[secret], `\${{ secrets.${secret} }}`, `${name} passes ${secret}`);
      }
    }
    // The only other secrets are the optional follow-up ones, read by steps of the last job.
    assert.deepEqual(secretReferences(rollout).followups,
      ['secrets.DEPLOY_HOST', 'secrets.DEPLOY_SSH_KEY', 'secrets.DEPLOY_USER', 'secrets.RELEASE_FOLLOWUP_ISSUES_TOKEN']);
    assert.deepEqual(Object.keys(secretReferences(rollout)).sort(), ['followups', 'linux-signing', 'runtime-agent', 'runtime-app-ui']);
  });

  test('the follow-ups job only starts the demo deploy detached, so its timeout cannot cut the refresh', () => {
    const demo = jobs.followups.steps.find(step => step.id === 'demo');
    assert.match(demo.name, /^Start the demo deploy over SSH/);
    assert.ok(jobs.followups['timeout-minutes'] <= 30);
    assert.match(demo.run, /systemd-run --unit=\$unit --collect /);
    assert.match(demo.run, /unit="propr-release-deploy-\$VERSION"/);
    assert.match(demo.run, /log="\/root\/propr-deploy\/logs\/release-deploy-\$VERSION\.log"/);
    assert.match(demo.run, /--property=StandardOutput=append:\$log --property=StandardError=append:\$log \/root\/propr-deploy\/scripts\/deploy\.sh all"/);
    assert.doesNotMatch(demo.run, /cd \/root\/propr-deploy && \.\/scripts\/deploy\.sh all/, 'no deploy in the foreground of the SSH session');
    assert.doesNotMatch(demo.run, /--wait\b|--pty\b/);
    assert.match(demo.run, /-o ServerAliveInterval=30 -o ServerAliveCountMax=4/);
    assert.match(demo.run, /echo 'result=started'/);
    assert.match(rolloutText, /^# it starts the documented demo deploy \(\.\/scripts\/deploy\.sh all\) on the host as\n# a detached systemd unit/m);
    assert.match(rolloutText, /^# by the job timeout\. Until demo\.propr\.dev reports the release, the demo\n# follow-up issue is still opened/m);
  });

  test('grants each call only the permissions its called jobs already declare', () => {
    const permissions = Object.fromEntries(Object.entries(jobs).map(([name, job]) => [name, job.permissions]));
    assert.deepEqual(permissions, {
      plan: { contents: 'read' },
      'runtime-agent': { contents: 'read' },
      'runtime-app-ui': { contents: 'read' },
      runtime: { contents: 'read' },
      'linux-draft': { contents: 'write' },
      'linux-signing': { contents: 'write', actions: 'read' },
      'linux-publication': { contents: 'write', actions: 'read' },
      macos: { contents: 'write', 'id-token': 'write', attestations: 'write' },
      'cli-bundle': { contents: 'read' },
      summary: { contents: 'read' },
      followups: { contents: 'read' },
    });
    const rank = { none: 0, read: 1, write: 2 };
    const mapping = { linux: 'linux-draft', signed: 'linux-signing', macos: 'macos', cli: 'cli-bundle', runtime: 'runtime-app-ui' };
    for (const [key, caller] of Object.entries(mapping)) {
      const granted = jobs[caller].permissions;
      const union = {};
      for (const job of Object.values(called[key].jobs)) {
        for (const [scope, level] of Object.entries(job.permissions ?? called[key].permissions)) {
          union[scope] = rank[level] > rank[union[scope] ?? 'none'] ? level : union[scope] ?? level;
        }
      }
      assert.deepEqual(granted, union, `${caller} grants exactly what ${key}'s jobs request`);
    }
  });

  test('the summary marks steps skipped because their artefact exists', () => {
    const run = jobs.summary.steps[0].run;
    const dir = mkdtempSync(join(tmpdir(), 'release-rollout-summary-'));
    fixtures.push(dir);
    const summary = join(dir, 'summary.md');
    const result = spawnSync('bash', ['-c', run], { encoding: 'utf8', env: {
      PATH: process.env.PATH, GITHUB_STEP_SUMMARY: summary, RELEASE_TAG: 'v0.9.3', SOURCE_REVISION: SHA,
      AGENT_IMAGE: `propr/agent:${SHA}@${digest('a')}`, APP_IMAGE: `propr/app:${SHA}@${digest('b')}`, UI_IMAGE: `propr/ui:${SHA}@${digest('c')}`,
      RUNTIME_AGENT: 'skipped', RUNTIME_APP_UI: 'success', LINUX_DRAFT: 'skipped', LINUX_SIGNING: 'skipped', LINUX_PUBLICATION: 'skipped',
      MACOS: 'failure', CLI_BUNDLE: 'success', PLAN_LINUX: 'false', PLAN_MACOS: 'true', PLAN_AGENT: 'false', PLAN_APP_UI: 'true',
    } });
    assert.equal(result.status, 0, result.stderr);
    const text = readFileSync(summary, 'utf8');
    assert.match(text, /\| Managed agent image \| already published \|/);
    assert.match(text, /\| App and UI images \| success \|/);
    assert.match(text, /\| Desktop Linux signed publication \| already published \|/);
    assert.match(text, /\| Desktop macOS preview \| failure \|/);
    assert.match(text, new RegExp(`propr/app:${SHA}@${digest('b')}`));
  });
});

describe('called workflows accept the in-progress Release Rollout run as the earlier step', () => {
  const repository = 'integry/propr';
  const rolloutRun = (overrides = {}) => ({
    id: 42, path: '.github/workflows/release-rollout.yml', event: 'workflow_dispatch', status: 'in_progress',
    repository: { full_name: repository }, ...overrides,
  });
  const context = { runId: '42', currentRunId: '42', workflowRef: releaseRolloutWorkflowRef(repository), repository };

  test('only the currently executing reviewed main Release Rollout run qualifies', () => {
    assert.equal(releaseRolloutWorkflowRef(repository), 'integry/propr/.github/workflows/release-rollout.yml@refs/heads/main');
    assert.equal(isCurrentReleaseRolloutRun(rolloutRun(), context), true);
    assert.equal(isCurrentReleaseRolloutRun(rolloutRun({ event: 'workflow_run' }), context), true);
    for (const [run, overrides] of [
      [rolloutRun({ status: 'completed' }), {}],
      [rolloutRun({ path: '.github/workflows/desktop-linux-preview.yml' }), {}],
      [rolloutRun({ event: 'pull_request' }), {}],
      [rolloutRun({ repository: { full_name: 'fork/propr' } }), {}],
      [rolloutRun({ id: 43 }), {}],
      [rolloutRun(), { currentRunId: '43' }],
      [rolloutRun(), { workflowRef: 'integry/propr/.github/workflows/release-rollout.yml@refs/heads/feature' }],
      [rolloutRun(), { workflowRef: 'integry/propr/.github/workflows/desktop-linux-signed-preview.yml@refs/heads/main' }],
      [rolloutRun(), { runId: '', currentRunId: '' }],
    ]) assert.equal(isCurrentReleaseRolloutRun(run, { ...context, ...overrides }), false, JSON.stringify([run, overrides]));
  });

  test('publication trusts a separate signing dispatch or the current rollout run', () => {
    const signing = { id: 7, event: 'workflow_dispatch', path: '.github/workflows/desktop-linux-signed-preview.yml',
      head_branch: 'main', conclusion: 'success', repository: { full_name: repository } };
    assert.equal(trustedSigningRun(signing, { signingRunId: '7', repository, currentRunId: '9', workflowRef: 'x' }), true);
    assert.equal(trustedSigningRun({ ...signing, conclusion: 'failure' }, { signingRunId: '7', repository }), false);
    assert.equal(trustedSigningRun({ ...signing, head_branch: 'feature' }, { signingRunId: '7', repository }), false);
    assert.equal(trustedSigningRun(rolloutRun(), { signingRunId: '42', ...context }), true);
    assert.equal(trustedSigningRun(rolloutRun(), { signingRunId: '42', ...context, workflowRef: 'other' }), false);
    // A finished rollout run is not a signing dispatch either.
    assert.equal(trustedSigningRun(rolloutRun({ status: 'completed', conclusion: 'success' }), { signingRunId: '42', ...context }), false);
  });

  test('the signing identity gate keeps the separate-dispatch rules and adds the same-run rule', () => {
    const identity = called.signed.jobs.identity.steps.find(step => step.id === 'identity');
    assert.equal(identity.env.CURRENT_RUN_ID, '${{ github.run_id }}');
    assert.equal(identity.env.WORKFLOW_REF, '${{ github.workflow_ref }}');
    assert.match(identity.run, /import \{ isCurrentReleaseRolloutRun \} from '\.\/apps\/desktop\/scripts\/release-rollout-run\.mjs'/);
    assert.match(identity.run, /if \(runId === currentRunId\) \{[\s\S]+isCurrentReleaseRolloutRun\(run, \{ runId, currentRunId, workflowRef, repository \}\)/);
    assert.match(identity.run, /run\.path !== '\.github\/workflows\/desktop-linux-preview\.yml'/);
  });
});

describe('release rollout plan', () => {
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const repo = ({ version = '0.9.3', desktop = version } = {}) => {
    const dir = mkdtempSync(join(tmpdir(), 'release-rollout-plan-'));
    fixtures.push(dir);
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 't@example.com');
    git(dir, 'config', 'user.name', 'Test');
    execFileSync('mkdir', ['-p', join(dir, 'apps/desktop')]);
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ version }));
    writeFileSync(join(dir, 'apps/desktop/package.json'), JSON.stringify({ version: desktop }));
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'release');
    const tagged = git(dir, 'rev-parse', 'HEAD');
    git(dir, 'tag', `v${version}`);
    writeFileSync(join(dir, 'later'), 'x');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'later');
    const main = git(dir, 'rev-parse', 'HEAD');
    return { dir, tagged, main, run: args => git(dir, ...args) };
  };

  test('takes the tag from the dispatch input, or from a successful Docker Images tag push', () => {
    assert.deepEqual(releaseTagFromTrigger({ eventName: 'workflow_dispatch', inputTag: 'v0.9.3' }),
      { releaseTag: 'v0.9.3', expectedSourceRevision: undefined });
    assert.deepEqual(releaseTagFromTrigger({ eventName: 'workflow_run',
      workflowRun: { conclusion: 'success', event: 'push', headBranch: 'v0.9.3', headSha: SHA } }),
    { releaseTag: 'v0.9.3', expectedSourceRevision: SHA });
    for (const inputTag of ['0.9.3', 'v0.9', 'v0.9.3-rc.1', 'desktop-v0.9.3', 'v01.2.3', '', undefined]) {
      assert.throws(() => releaseTagFromTrigger({ eventName: 'workflow_dispatch', inputTag }), /release_tag/, String(inputTag));
    }
    const good = { conclusion: 'success', event: 'push', headBranch: 'v0.9.3', headSha: SHA };
    for (const bad of [{ conclusion: 'failure' }, { event: 'workflow_dispatch' }, { headBranch: 'main' },
      { headBranch: 'desktop-v1.0.0' }, { headSha: 'abc' }]) {
      assert.throws(() => releaseTagFromTrigger({ eventName: 'workflow_run', workflowRun: { ...good, ...bad } }), JSON.stringify(bad));
    }
    assert.throws(() => releaseTagFromTrigger({ eventName: 'push', inputTag: 'v0.9.3' }));
  });

  test('binds the tag commit, not main or a later commit, as the source revision', () => {
    const { dir, tagged, main, run } = repo();
    const at = args => run(args);
    const resolved = resolveSource({ releaseTag: 'v0.9.3', workflowSha: main, dispatchRef: 'refs/heads/main', git: at });
    assert.deepEqual(resolved, { releaseTag: 'v0.9.3', sourceRevision: tagged, version: '0.9.3', desktopVersion: '0.9.3' });
    assert.deepEqual(resolveSource({ releaseTag: 'v0.9.3', expectedSourceRevision: tagged, workflowSha: main,
      dispatchRef: 'refs/heads/main', git: at }).sourceRevision, tagged);
    assert.throws(() => resolveSource({ releaseTag: 'v0.9.3', expectedSourceRevision: main, workflowSha: main,
      dispatchRef: 'refs/heads/main', git: at }), /names .* not the released commit/);
    assert.throws(() => resolveSource({ releaseTag: 'v0.9.4', workflowSha: main, dispatchRef: 'refs/heads/main', git: at }), /does not exist/);
    assert.throws(() => resolveSource({ releaseTag: 'v0.9.3', workflowSha: main, dispatchRef: 'refs/heads/feature', git: at }), /main branch/);
    assert.throws(() => resolveSource({ releaseTag: 'v0.9.3', workflowSha: tagged, dispatchRef: 'refs/heads/main', git: at }), /reviewed main/);
    // A tag on a commit main does not contain is refused.
    run(['checkout', '-q', '-b', 'side', tagged]);
    writeFileSync(join(dir, 'side'), 'x');
    run(['add', '.']);
    run(['commit', '-qm', 'side']);
    run(['tag', 'v0.9.5']);
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '0.9.5' }));
    run(['checkout', '-q', 'main']);
    assert.throws(() => resolveSource({ releaseTag: 'v0.9.5', workflowSha: main, dispatchRef: 'refs/heads/main', git: at }),
      /(not reachable|does not have version)/);
  });

  test('refuses a tag whose package version is not the tag version', () => {
    const { main, run } = repo({ version: '0.9.3' });
    run(['tag', '-f', 'v0.9.9', 'HEAD~1']);
    assert.throws(() => resolveSource({ releaseTag: 'v0.9.9', workflowSha: main, dispatchRef: 'refs/heads/main', git: run }),
      /does not have version 0\.9\.9/);
  });

  test('names the exact preview prerelease tags of the tag commit', () => {
    const releases = previewReleases({ desktopVersion: '0.9.3', sourceRevision: SHA });
    assert.equal(releases.linux.tag, 'desktop-linux-preview-v0.9.3-0c6213a643f3-all-signed');
    assert.equal(releases.macos.tag, 'desktop-macos-preview-v0.9.3-0c6213a643f3');
    assert.ok(releases.linux.assets.includes('ProPR-Desktop-0.9.3-linux-arm64.rpm'));
    assert.ok(releases.macos.assets.includes('ProPR-Desktop-0.9.3-macos-x64.dmg'));
  });

  test('finds a published preview prerelease, treats a missing one as to-do, and stops on a broken one', async () => {
    const { tag, assets } = previewReleases({ desktopVersion: '0.9.3', sourceRevision: SHA }).macos;
    const requests = [];
    const reply = (status, body) => async (url, init) => {
      requests.push([url, init]);
      return { status, ok: status >= 200 && status < 300, json: async () => body };
    };
    const release = { tag_name: tag, draft: false, prerelease: true, published_at: '2026-11-18T00:00:00Z',
      html_url: `https://github.com/integry/propr/releases/tag/${tag}`, assets: assets.map(name => ({ name })) };
    assert.deepEqual(await publishedPreviewRelease({ tag, assets, token: 't', fetchImpl: reply(200, release) }),
      { tag, url: release.html_url });
    assert.equal(requests[0][0], `https://api.github.com/repos/integry/propr/releases/tags/${tag}`);
    assert.equal(requests[0][1].headers.Authorization, 'Bearer t');
    assert.equal(await publishedPreviewRelease({ tag, assets, fetchImpl: reply(404, {}) }), null);
    await assert.rejects(publishedPreviewRelease({ tag, assets, fetchImpl: reply(500, {}) }), /HTTP 500/);
    await assert.rejects(publishedPreviewRelease({ tag, assets, fetchImpl: reply(200, { ...release, prerelease: false }) }),
      /not a published preview prerelease/);
    await assert.rejects(publishedPreviewRelease({ tag, assets, fetchImpl: reply(200, { ...release, assets: release.assets.slice(1) }) }),
      /is missing .*repair it by hand/);
  });

  test('plans to skip every artefact that already exists and pass the existing digests along', async () => {
    const { tagged, main, run } = repo();
    const existing = { app: `propr/app:${tagged}@${digest('a')}`, ui: `propr/ui:${tagged}@${digest('b')}`, agent: `propr/agent:${tagged}@${digest('c')}` };
    const releases = previewReleases({ desktopVersion: '0.9.3', sourceRevision: tagged });
    const fetchImpl = async url => {
      const tag = decodeURIComponent(url.split('/').at(-1));
      const channel = tag === releases.linux.tag ? 'linux' : 'macos';
      return { status: 200, ok: true, json: async () => ({ tag_name: tag, draft: false, prerelease: true, published_at: 'x',
        html_url: `https://example.test/${tag}`, assets: releases[channel].assets.map(name => ({ name })) }) };
    };
    const plan = await planRollout({ eventName: 'workflow_dispatch', inputTag: 'v0.9.3', workflowSha: main,
      dispatchRef: 'refs/heads/main', git: run, fetchImpl, inspectRuntime: revision => {
        assert.equal(revision, tagged);
        return existing;
      } });
    assert.deepEqual(rolloutOutputs(plan), {
      release_tag: 'v0.9.3', source_revision: tagged, version: '0.9.3',
      desktop_version: '0.9.3', linux_release_tag: releases.linux.tag, macos_release_tag: releases.macos.tag,
      runtime_app_image: existing.app, runtime_ui_image: existing.ui, runtime_agent_image: existing.agent,
      publish_agent: 'false', publish_app_ui: 'false', linux: 'false', macos: 'false',
    });
    const summary = planSummary(plan);
    assert.match(summary, /Managed agent image \| already published/);
    assert.match(summary, new RegExp(`already published: \\[\`${releases.linux.tag}\`\\]`));

    const fresh = await planRollout({ eventName: 'workflow_dispatch', inputTag: 'v0.9.3', workflowSha: main,
      dispatchRef: 'refs/heads/main', git: run, fetchImpl: async () => ({ status: 404, ok: false }),
      inspectRuntime: () => ({ app: existing.app, ui: null, agent: null }) });
    assert.deepEqual(rolloutOutputs(fresh), {
      release_tag: 'v0.9.3', source_revision: tagged, version: '0.9.3',
      desktop_version: '0.9.3', linux_release_tag: releases.linux.tag, macos_release_tag: releases.macos.tag,
      runtime_app_image: existing.app, runtime_ui_image: '', runtime_agent_image: '',
      publish_agent: 'true', publish_app_ui: 'true', linux: 'true', macos: 'true',
    });
    assert.match(planSummary(fresh), /UI image \| publish \(Preview Runtime Images `publish`\)/);
    assert.equal(formatOutputs({ a: 'b' }), 'a=b\n');
    assert.throws(() => formatOutputs({ a: 'b\nc=d' }), /single line/);
  });

  test('passes this run\'s publication, else the existing image, and nothing unbound', () => {
    const ref = (image, revision = SHA, character = 'a') => `propr/${image}:${revision}@${digest(character)}`;
    assert.deepEqual(runtimeReferences({ sourceRevision: SHA,
      published: { app: ref('app', SHA, 'd'), ui: ref('ui', SHA, 'e'), agent: '' },
      existing: { app: ref('app'), ui: '', agent: ref('agent') } }), {
      runtime_app_image: ref('app', SHA, 'd'), runtime_ui_image: ref('ui', SHA, 'e'), runtime_agent_image: ref('agent'),
    });
    for (const published of [{ app: ref('app', OTHER) }, { app: `propr/app:${SHA}` }, { app: `propr/app:latest@${digest('a')}` },
      { app: ref('ui') }]) {
      assert.throws(() => runtimeReferences({ sourceRevision: SHA, published: { ui: ref('ui'), agent: ref('agent'), ...published } }),
        /No published propr\/app/, JSON.stringify(published));
    }
    assert.throws(() => runtimeReferences({ sourceRevision: SHA, existing: { app: ref('app'), ui: ref('ui') } }), /propr\/agent/);
  });
});

describe('published preview runtime inspection', () => {
  // An in-memory registry: `tags` maps repository to the platforms its SHA tag holds.
  const registryFor = (tags, revision = SHA) => {
    const manifests = {};
    for (const [image, platforms] of Object.entries(tags)) {
      manifests[image] = platforms.length > 1 || image !== 'agent'
        ? { manifests: platforms.map((architecture, index) => ({ digest: digest('abc'[index]), platform: { os: 'linux', architecture } })) }
        : null;
    }
    const spawn = (command, args) => {
      const image = args[2].match(/propr\/(app|ui|agent):/)[1];
      return image in tags ? { status: 0, stdout: '{}', stderr: '' } : { status: 1, stdout: '', stderr: 'manifest unknown' };
    };
    const registry = args => {
      const image = args[2].match(/propr\/(app|ui|agent)/)?.[1];
      if (args[0] === 'image' && args[1] === 'digest') return digest('f');
      if (args[0] === 'manifest' && args[1] === 'get') {
        if (args[2].includes('@')) return JSON.stringify({ config: { digest: digest(args[2].endsWith(digest('b')) ? 'e' : 'd') } });
        return JSON.stringify(manifests[image] ?? { config: { digest: digest('d') } });
      }
      if (args[0] === 'blob' && args[1] === 'get') {
        const architecture = args[3] === digest('e') ? 'arm64' : 'amd64';
        return JSON.stringify({ os: 'linux', architecture, config: { Labels: {
          'org.opencontainers.image.source': 'https://github.com/integry/propr', 'org.opencontainers.image.revision': revision,
          'dev.propr.agent-bundle': 'true', 'dev.propr.agent-tank.version': '1.0.0',
          ...Object.fromEntries(['claude', 'codex', 'antigravity', 'opencode', 'vibe'].map(cli => [`dev.propr.agent.${cli}.version`, '1.0.0'])),
        } } });
      }
      throw new Error(`Unexpected registry operation ${args}`);
    };
    return { spawn, registry };
  };

  test('reports the digest-pinned reference of each existing image and null for a missing one', () => {
    const found = inspectPublishedRuntime(SHA, registryFor({ app: ['amd64', 'arm64'], agent: ['amd64'] }));
    assert.deepEqual(found, { app: `propr/app:${SHA}@${digest('f')}`, ui: null, agent: `propr/agent:${SHA}@${digest('f')}` });
    assert.throws(() => inspectPublishedRuntime('abc', registryFor({})), /full lowercase/);
  });

  test('a single-architecture release image under the bare app tag fails closed with the reason', () => {
    assert.throws(() => inspectPublishedRuntime(SHA, registryFor({ app: ['amd64'] })),
      /propr\/app:0c6213a643f3\S* already exists but is not the source-bound two-architecture preview manifest[\s\S]+release-<sha>/);
    assert.throws(() => inspectPublishedRuntime(SHA, registryFor({ ui: ['amd64', 'arm64'] }, OTHER)),
      /propr\/ui:\S+ already exists but is not the source-bound two-architecture preview manifest \(.*not independently bound/);
  });
});
