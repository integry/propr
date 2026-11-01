import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { parse } from 'yaml';
import { bundleHasVersion, requireVersion, resolveEntryBundle, verifyHostedUi }
  from '../scripts/verify-hosted-ui-release.mjs';

const text = readFileSync('.github/workflows/docker-images.yml', 'utf8');
const workflow = parse(text);
const job = workflow.jobs['deploy-hosted-ui'];
const steps = job.steps;
const step = name => {
  const found = steps.find(candidate => candidate.name === name);
  assert.ok(found, `missing step ${name}`);
  return found;
};
const RELEASE_REF = "${{ github.event_name == 'workflow_dispatch' && format('v{0}', inputs.expected_version) || github.ref }}";
const CONFIGURED = "steps.credentials.outputs.configured == 'true'";
const rootPackage = JSON.parse(readFileSync('package.json', 'utf8'));

describe('hosted UI release deploy workflow contract', () => {
  test('runs only after the GitHub release is published, on tag and manual release paths', () => {
    assert.deepEqual(Object.keys(workflow.on).sort(), ['push', 'workflow_dispatch']);
    assert.equal(job.if, workflow.jobs['publish-github-release'].if);
    assert.equal(job.if, "github.ref_type == 'tag' || github.event_name == 'workflow_dispatch'");
    // Default success() gating: a failed or skipped release skips the deploy.
    assert.deepEqual(job.needs, ['validate-release', 'publish-github-release']);
    assert.doesNotMatch(job.if, /always\(\)|failure\(\)|cancelled\(\)/);
  });

  test('runs in the protected hosted-ui-production environment with read-only contents', () => {
    assert.deepEqual(job.environment, { name: 'hosted-ui-production', url: 'https://app.propr.dev/' });
    assert.deepEqual(job.permissions, { contents: 'read' });
    assert.equal(workflow.jobs['publish-github-release'].environment, undefined);
  });

  test('Cloudflare secrets are read only by the environment-scoped job', () => {
    for (const [name, other] of Object.entries(workflow.jobs)) {
      if (name === 'deploy-hosted-ui') continue;
      assert.doesNotMatch(JSON.stringify(other), /CLOUDFLARE|hosted-ui-production|wrangler/i, `${name} must not see the Cloudflare deploy`);
    }
    assert.equal(job.env, undefined, 'no job-level env exposes secrets to every step');
    const secretSteps = steps.filter(candidate => JSON.stringify(candidate).includes('secrets.')).map(candidate => candidate.name);
    assert.deepEqual(secretSteps, ['Check Cloudflare credentials', 'Deploy to Cloudflare Workers']);
    for (const name of secretSteps) {
      const { env } = step(name);
      assert.equal(env.CLOUDFLARE_API_TOKEN, '${{ secrets.CLOUDFLARE_API_TOKEN }}');
      assert.equal(env.CLOUDFLARE_ACCOUNT_ID, '${{ secrets.CLOUDFLARE_ACCOUNT_ID }}');
      assert.doesNotMatch(step(name).run, /secrets\./, 'secrets reach the shell only through env');
    }
  });

  test('checks out the exact release ref without persisting credentials', () => {
    const checkout = step('Checkout repository');
    assert.match(checkout.uses, /^actions\/checkout@[0-9a-f]{40}$/);
    assert.deepEqual(checkout.with, { ref: RELEASE_REF, 'persist-credentials': false });
    assert.equal(workflow.jobs['validate-release'].steps[0].with.ref, RELEASE_REF);
    assert.match(step('Confirm checkout is the release version').env.RELEASE_VERSION, /needs\.validate-release\.outputs\.version/);
  });

  test('builds and deploys the same way as npm run deploy:hosted-ui, with a locked install', () => {
    const order = ['Check Cloudflare credentials', 'Checkout repository', 'Set up Node.js', 'Confirm checkout is the release version',
      'Install dependencies', 'Build hosted UI', 'Deploy to Cloudflare Workers', 'Verify app.propr.dev serves the release'];
    assert.deepEqual(steps.map(candidate => candidate.name).filter(name => order.includes(name)), order);
    assert.equal(step('Install dependencies').run, 'npm ci');
    assert.equal(step('Build hosted UI').run, 'npm run build -w propr-ui');
    assert.match(step('Deploy to Cloudflare Workers').run, /^npx --yes wrangler@\d+\.\d+\.\d+ deploy --config wrangler\.hosted-ui\.toml$/);
    assert.equal(rootPackage.scripts['deploy:hosted-ui'],
      'npm run build -w propr-ui && npx wrangler deploy --config wrangler.hosted-ui.toml');
    for (const name of order.slice(1)) assert.equal(step(name).if, CONFIGURED, `${name} must skip without credentials`);
    for (const candidate of steps) assert.equal(candidate['continue-on-error'], undefined);
  });

  test('skips with a notice instead of failing when the environment secrets are missing', () => {
    const { run } = step('Check Cloudflare credentials');
    const dir = mkdtempSync(join(tmpdir(), 'hosted-ui-credentials-'));
    try {
      let runs = 0;
      const execute = env => {
        runs += 1;
        const output = join(dir, `output-${runs}`);
        const summary = join(dir, `summary-${runs}`);
        const result = spawnSync('bash', ['-e', '-c', run], {
          env: { PATH: process.env.PATH, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary, ...env }, encoding: 'utf8',
        });
        return { ...result, output: readFileSync(output, 'utf8'), summary: (() => { try { return readFileSync(summary, 'utf8'); } catch { return ''; } })() };
      };
      const configured = execute({ CLOUDFLARE_API_TOKEN: 'token', CLOUDFLARE_ACCOUNT_ID: 'account' });
      assert.equal(configured.status, 0);
      assert.equal(configured.output, 'configured=true\n');
      assert.equal(configured.stdout, '');
      for (const env of [{}, { CLOUDFLARE_API_TOKEN: 'cf-secret-sentinel' }, { CLOUDFLARE_ACCOUNT_ID: 'cf-secret-sentinel', CLOUDFLARE_API_TOKEN: '' }]) {
        const skipped = execute(env);
        assert.equal(skipped.status, 0, JSON.stringify(env));
        assert.equal(skipped.output, 'configured=false\n');
        assert.match(skipped.stdout, /^::notice title=Hosted UI deploy skipped::.*hosted-ui-production/);
        assert.match(skipped.summary, /Hosted UI deploy skipped/);
        assert.doesNotMatch(skipped.stdout + skipped.summary, /cf-secret-sentinel/, 'secret values are never echoed');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('verifies the released version after deploy and leaves reconciliation guidance on failure', () => {
    const verify = step('Verify app.propr.dev serves the release');
    assert.equal(verify.run, 'node scripts/verify-hosted-ui-release.mjs');
    assert.deepEqual(verify.env, { RELEASE_VERSION: '${{ needs.validate-release.outputs.version }}' });
    assert.equal(steps.at(-1).if, 'failure()');
    assert.match(steps.at(-1).run, /deploy:hosted-ui/);
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
