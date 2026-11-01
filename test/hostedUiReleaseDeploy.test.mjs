import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { parse } from 'yaml';
import { bundleHasVersion, requireVersion, resolveEntryBundle, verifyHostedUi }
  from '../scripts/verify-hosted-ui-release.mjs';

const workflow = parse(readFileSync('.github/workflows/docker-images.yml', 'utf8'));
const job = workflow.jobs['deploy-hosted-ui'];
const deployWorkflow = parse(readFileSync('.github/workflows/hosted-ui-deploy.yml', 'utf8'));
const deployJob = deployWorkflow.jobs.deploy;
const steps = deployJob.steps;
const step = name => {
  const found = steps.find(candidate => candidate.name === name);
  assert.ok(found, `missing step ${name}`);
  return found;
};
const CONFIGURED = "steps.credentials.outputs.configured == 'true'";
const rootPackage = JSON.parse(readFileSync('package.json', 'utf8'));

const runStep = (run, env, dir, label) => {
  const output = join(dir, `output-${label}`);
  const summary = join(dir, `summary-${label}`);
  const result = spawnSync('bash', ['-e', '-c', run], {
    env: { PATH: process.env.PATH, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary, ...env }, encoding: 'utf8',
  });
  const read = file => { try { return readFileSync(file, 'utf8'); } catch { return ''; } };
  return { ...result, output: read(output), summary: read(summary) };
};

describe('hosted UI release deploy workflow contract', () => {
  test('runs only after the GitHub release is published, on tag and manual release paths', () => {
    assert.deepEqual(Object.keys(workflow.on).sort(), ['push', 'workflow_dispatch']);
    assert.equal(job.if, workflow.jobs['publish-github-release'].if);
    assert.equal(job.if, "github.ref_type == 'tag' || github.event_name == 'workflow_dispatch'");
    // Default success() gating: a failed or skipped release skips the deploy.
    assert.deepEqual(job.needs, ['validate-release', 'publish-github-release']);
    assert.doesNotMatch(job.if, /always\(\)|failure\(\)|cancelled\(\)/);
  });

  test('the release job and the manual re-deploy share one reusable workflow', () => {
    assert.equal(job.name, 'Deploy hosted UI (app.propr.dev)');
    assert.equal(job.uses, './.github/workflows/hosted-ui-deploy.yml');
    assert.deepEqual(job.with, { release_tag: '${{ needs.validate-release.outputs.release_tag }}' });
    assert.equal(job.secrets, undefined, 'no caller secrets: the environment-scoped job reads its own');
    assert.equal(job.steps, undefined);
    assert.deepEqual(Object.keys(deployWorkflow.on).sort(), ['workflow_call', 'workflow_dispatch']);
    for (const trigger of ['workflow_call', 'workflow_dispatch']) {
      assert.deepEqual(Object.keys(deployWorkflow.on[trigger].inputs), ['release_tag']);
      assert.equal(deployWorkflow.on[trigger].inputs.release_tag.required, true);
      assert.equal(deployWorkflow.on[trigger].inputs.release_tag.type, 'string');
    }
    assert.deepEqual(Object.keys(deployWorkflow.jobs), ['deploy']);
  });

  test('runs in the protected hosted-ui-production environment with read-only contents', () => {
    assert.deepEqual(deployJob.environment, { name: 'hosted-ui-production', url: 'https://app.propr.dev/' });
    assert.deepEqual(deployJob.concurrency, { group: 'hosted-ui-production', 'cancel-in-progress': false });
    assert.deepEqual(deployWorkflow.permissions, { contents: 'read' });
    assert.deepEqual(deployJob.permissions, { contents: 'read' });
    assert.deepEqual(job.permissions, { contents: 'read' });
    assert.equal(workflow.jobs['publish-github-release'].environment, undefined);
  });

  test('Cloudflare secrets are read only by the environment-scoped job', () => {
    for (const [name, other] of Object.entries(workflow.jobs)) {
      if (name === 'deploy-hosted-ui') continue;
      assert.doesNotMatch(JSON.stringify(other), /CLOUDFLARE|hosted-ui-production|wrangler|hosted-ui-deploy/i, `${name} must not see the Cloudflare deploy`);
    }
    assert.doesNotMatch(JSON.stringify(job), /CLOUDFLARE|secrets/);
    assert.equal(deployJob.env, undefined, 'no job-level env exposes secrets to every step');
    assert.equal(deployWorkflow.env, undefined);
    const secretSteps = steps.filter(candidate => JSON.stringify(candidate).includes('secrets.')).map(candidate => candidate.name);
    assert.deepEqual(secretSteps, ['Check Cloudflare credentials', 'Deploy to Cloudflare Workers']);
    for (const name of secretSteps) {
      const { env } = step(name);
      assert.equal(env.CLOUDFLARE_API_TOKEN, '${{ secrets.CLOUDFLARE_API_TOKEN }}');
      assert.equal(env.CLOUDFLARE_ACCOUNT_ID, '${{ secrets.CLOUDFLARE_ACCOUNT_ID }}');
      assert.doesNotMatch(step(name).run, /secrets\./, 'secrets reach the shell only through env');
    }
  });

  test('pins every action by commit SHA', () => {
    const uses = steps.filter(candidate => candidate.uses).map(candidate => candidate.uses);
    assert.ok(uses.length >= 2);
    for (const action of uses) assert.match(action, /^actions\/[a-z-]+@[0-9a-f]{40}$/);
  });

  test('checks out the release tag, not the dispatching ref, without persisting credentials', () => {
    const checkout = step('Checkout release tag');
    assert.deepEqual(checkout.with, { ref: 'refs/tags/${{ inputs.release_tag }}', 'persist-credentials': false });
    for (const name of ['Confirm checkout is the release version', 'Verify app.propr.dev serves the release']) {
      assert.deepEqual(step(name).env, { RELEASE_VERSION: '${{ steps.release.outputs.version }}' });
    }
    const confirm = step('Confirm checkout is the release version').run;
    assert.match(confirm, /require\('\.\/package\.json'\)\.version/);
    assert.match(confirm, /exit 1/);
  });

  test('builds @propr/shared before the UI and deploys with a locked install', () => {
    const order = ['Validate release tag', 'Check Cloudflare credentials', 'Checkout release tag', 'Set up Node.js',
      'Confirm checkout is the release version', 'Install dependencies', 'Build shared workspace', 'Build hosted UI',
      'Deploy to Cloudflare Workers', 'Verify app.propr.dev serves the release'];
    assert.deepEqual(steps.map(candidate => candidate.name).slice(0, order.length), order);
    assert.equal(step('Install dependencies').run, 'npm ci');
    assert.equal(step('Build shared workspace').run, 'npm run build -w @propr/shared');
    assert.equal(step('Build hosted UI').run, 'npm run build -w propr-ui');
    assert.equal(step('Deploy to Cloudflare Workers').run, 'npx --yes wrangler@4.156.0 deploy --config wrangler.hosted-ui.toml');
    assert.equal(step('Validate release tag').if, undefined, 'a bad release_tag fails even without credentials');
    for (const name of order.slice(2)) assert.equal(step(name).if, CONFIGURED, `${name} must skip without credentials`);
    for (const candidate of steps) assert.equal(candidate['continue-on-error'], undefined);
  });

  test('npm run deploy:hosted-ui builds @propr/shared before the UI', () => {
    assert.equal(rootPackage.scripts['deploy:hosted-ui'],
      'npm run build -w @propr/shared && npm run build -w propr-ui && npx wrangler deploy --config wrangler.hosted-ui.toml');
  });

  test('accepts only an existing v<semver> release tag, dispatched from main', () => {
    const validate = step('Validate release tag');
    assert.deepEqual(validate.env, {
      GH_TOKEN: '${{ github.token }}',
      RELEASE_TAG: '${{ inputs.release_tag }}',
      DISPATCHED_WORKFLOW: '${{ github.workflow_ref }}',
      DISPATCHED_REF: '${{ github.ref }}',
    });
    const dir = mkdtempSync(join(tmpdir(), 'hosted-ui-tag-'));
    try {
      // A stub gh: only refs/tags/v0.9.1 and v1.0.0-rc.1 exist.
      const bin = join(dir, 'bin');
      mkdirSync(bin);
      const calls = join(dir, 'gh-calls');
      writeFileSync(join(bin, 'gh'), `#!/bin/sh\necho "$*" >> "${calls}"\ncase "$2" in\n  */git/ref/tags/v0.9.1|*/git/ref/tags/v1.0.0-rc.1) exit 0;;\n  *) exit 1;;\nesac\n`);
      chmodSync(join(bin, 'gh'), 0o755);
      let runs = 0;
      const execute = env => runStep(validate.run, {
        PATH: `${bin}:${process.env.PATH}`, GITHUB_REPOSITORY: 'integry/propr', GH_TOKEN: 'token',
        DISPATCHED_WORKFLOW: 'integry/propr/.github/workflows/hosted-ui-deploy.yml@refs/heads/main',
        DISPATCHED_REF: 'refs/heads/main', ...env,
      }, dir, String(runs += 1));

      for (const [tag, version] of [['v0.9.1', '0.9.1'], ['v1.0.0-rc.1', '1.0.0-rc.1']]) {
        const ok = execute({ RELEASE_TAG: tag });
        assert.equal(ok.status, 0, ok.stderr);
        assert.equal(ok.output, `version=${version}\n`);
      }
      assert.match(readFileSync(calls, 'utf8'), /^api repos\/integry\/propr\/git\/ref\/tags\/v0\.9\.1 --silent$/m);

      for (const tag of ['', '0.9.1', 'v0.9', 'v01.9.1', 'v0.9.1 ', 'main', 'v0.9.1;id', 'refs/tags/v0.9.1']) {
        const bad = execute({ RELEASE_TAG: tag });
        assert.equal(bad.status, 1, JSON.stringify(tag));
        assert.match(bad.stderr, /must look like v<semver>/);
        assert.equal(bad.output, '');
      }
      const missing = execute({ RELEASE_TAG: 'v9.9.9' });
      assert.equal(missing.status, 1);
      assert.match(missing.stderr, /v9\.9\.9 does not exist/);

      const fromBranch = execute({ RELEASE_TAG: 'v0.9.1', DISPATCHED_WORKFLOW: 'integry/propr/.github/workflows/hosted-ui-deploy.yml@refs/heads/feature', DISPATCHED_REF: 'refs/heads/feature' });
      assert.equal(fromBranch.status, 1);
      assert.match(fromBranch.stderr, /from main/);
      const fromTag = execute({ RELEASE_TAG: 'v0.9.1', DISPATCHED_WORKFLOW: 'integry/propr/.github/workflows/hosted-ui-deploy.yml@refs/tags/v0.9.1', DISPATCHED_REF: 'refs/tags/v0.9.1' });
      assert.equal(fromTag.status, 1);

      // Called from the release workflow, github.* describes the tag run.
      const fromRelease = execute({ RELEASE_TAG: 'v0.9.1', DISPATCHED_WORKFLOW: 'integry/propr/.github/workflows/docker-images.yml@refs/tags/v0.9.1', DISPATCHED_REF: 'refs/tags/v0.9.1' });
      assert.equal(fromRelease.status, 0, fromRelease.stderr);
      assert.equal(fromRelease.output, 'version=0.9.1\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('skips with a notice instead of failing when the environment secrets are missing', () => {
    const { run } = step('Check Cloudflare credentials');
    const dir = mkdtempSync(join(tmpdir(), 'hosted-ui-credentials-'));
    try {
      let runs = 0;
      const execute = env => runStep(run, env, dir, String(runs += 1));
      const configured = execute({ CLOUDFLARE_API_TOKEN: 'token', CLOUDFLARE_ACCOUNT_ID: 'account' });
      assert.equal(configured.status, 0);
      assert.equal(configured.output, 'configured=true\n');
      assert.equal(configured.stdout, '');
      for (const env of [{}, { CLOUDFLARE_API_TOKEN: 'cf-secret-sentinel' }, { CLOUDFLARE_ACCOUNT_ID: 'cf-secret-sentinel', CLOUDFLARE_API_TOKEN: '' }]) {
        const skipped = execute(env);
        assert.equal(skipped.status, 0, JSON.stringify(env));
        assert.equal(skipped.output, 'configured=false\n');
        assert.match(skipped.stdout, /^::notice title=Hosted UI deploy skipped::.*hosted-ui-production.*Hosted UI Deploy workflow from main/);
        assert.match(skipped.summary, /Hosted UI deploy skipped/);
        assert.doesNotMatch(skipped.stdout + skipped.summary, /cf-secret-sentinel/, 'secret values are never echoed');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('verifies the released version after deploy and points reconciliation at the dispatch workflow', () => {
    assert.equal(step('Verify app.propr.dev serves the release').run, 'node scripts/verify-hosted-ui-release.mjs');
    const guidance = steps.at(-1);
    assert.equal(guidance.name, 'Show hosted UI reconciliation guidance');
    assert.equal(guidance.if, 'failure()');
    assert.deepEqual(guidance.env, { RELEASE_TAG: '${{ inputs.release_tag }}' });
    const dir = mkdtempSync(join(tmpdir(), 'hosted-ui-guidance-'));
    try {
      const result = runStep(guidance.run, { RELEASE_TAG: 'v0.9.1' }, dir, 'guidance');
      assert.equal(result.status, 0);
      assert.match(result.stderr, /Hosted UI Deploy workflow from main with release_tag v0\.9\.1/);
      assert.match(result.stderr, /deploy:hosted-ui/);
      assert.match(result.summary, /### Hosted UI reconciliation/);
      assert.match(result.summary, /hosted-ui-deploy\.yml.*`main`.*`v0\.9\.1`/);
      assert.doesNotMatch(result.summary, /Re-run the Deploy hosted UI job/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('hosted UI release verification', () => {
  const page = 'https://app.propr.dev/';
  const html = '<!doctype html><head><script type="module" crossorigin src="/assets/index-Dwuo6t2x.js"></script>'
    + '<link rel="modulepreload" href="/assets/index-wTEQD8cG.js"></head>';

  test('resolves the entry module index.html loads, not other index chunks', () => {
    assert.equal(resolveEntryBundle(html, page).href, 'https://app.propr.dev/assets/index-Dwuo6t2x.js');
    assert.throws(() => resolveEntryBundle('<html></html>', page), /does not load/);
    assert.throws(() => resolveEntryBundle(html.replace('/assets/', 'https://evil.example/assets/'), page), /not served from/);
  });

  test('matches the version only as the embedded string literal', () => {
    assert.equal(bundleHasVersion('const v="0.9.0";', '0.9.0'), true);
    assert.equal(bundleHasVersion('const v="0.9.0";', '0.9.1'), false);
    assert.equal(bundleHasVersion('const v="10.9.01";', '0.9.0'), false);
    assert.equal(requireVersion('1.2.3-rc.1'), '1.2.3-rc.1');
    for (const bad of [undefined, '', 'v0.9.0', '0.9', '0.9.0 ']) assert.throws(() => requireVersion(bad), /RELEASE_VERSION/);
  });

  const fakeFetch = responses => {
    const requests = [];
    const fetchImpl = async (url, init) => {
      requests.push({ url: new URL(url), init });
      const body = responses.shift();
      return body instanceof Error ? Promise.reject(body)
        : { ok: body !== 503, status: body === 503 ? 503 : 200, text: async () => body };
    };
    return { fetchImpl, requests };
  };

  test('retries until the edge serves the released bundle', async () => {
    const { fetchImpl, requests } = fakeFetch([503, html, 'const v="0.8.15";', new Error('ECONNRESET'), html, 'const v="0.9.0";']);
    const sleeps = [];
    const logs = [];
    const bundle = await verifyHostedUi({ url: page, version: '0.9.0', attempts: 4, delayMs: 5, fetchImpl,
      sleep: async ms => { sleeps.push(ms); }, log: message => logs.push(message) });
    assert.equal(bundle.pathname, '/assets/index-Dwuo6t2x.js');
    assert.deepEqual(sleeps, [5, 5, 5]);
    assert.equal(logs.length, 4);
    assert.match(logs[1], /does not contain "0\.9\.0"/);
    for (const { url, init } of requests) {
      assert.ok(url.searchParams.has('propr_release_check'));
      assert.equal(init.headers['cache-control'], 'no-cache');
    }
  });

  test('fails after the last attempt with the final reason', async () => {
    const { fetchImpl } = fakeFetch([html, 'const v="0.8.15";', html, 'const v="0.8.15";']);
    await assert.rejects(
      verifyHostedUi({ url: page, version: '0.9.0', attempts: 2, delayMs: 0, fetchImpl, sleep: async () => {}, log: () => {} }),
      /not serving ProPR 0\.9\.0 after 2 attempts: \/assets\/index-Dwuo6t2x\.js does not contain "0\.9\.0"/,
    );
  });
});
