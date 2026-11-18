import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { parse } from 'yaml';
import {
  REPOSITORIES, TOKEN_SECRET, demoDeploy, demoFollowup, fleetFollowup, followups, followupsSummary, inputsFromEnv, issuesTsv, prepare,
  releasePublishedAt, siteFollowup, stepDone,
} from '../scripts/release-followups.mjs';

const SHA = '0c6213a643f316bbe33f2800f858bd9462f83b74';
const digest = character => `sha256:${character.repeat(64)}`;
const images = { app: `propr/app:${SHA}@${digest('a')}`, ui: `propr/ui:${SHA}@${digest('b')}`, agent: `propr/agent:${SHA}@${digest('c')}` };
const LINUX_TAG = 'desktop-linux-preview-v0.9.3-0c6213a643f3-all-signed';
const MACOS_TAG = 'desktop-macos-preview-v0.9.3-0c6213a643f3';
const CLI_VERSION = `0.9.3-preview.${SHA}.${'d'.repeat(64)}`;
const env = (overrides = {}) => ({
  VERSION: '0.9.3', RELEASE_TAG: 'v0.9.3', SOURCE_REVISION: SHA, RUN_ID: '41300723460', DESKTOP_VERSION: '0.9.3',
  APP_IMAGE: images.app, UI_IMAGE: images.ui, AGENT_IMAGE: images.agent,
  CLI_BUNDLE: 'success', CLI_VERSION, CLI_ARTIFACT_NAME: `propr-cli-preview-${SHA}-41300723460`, CLI_ARTIFACT_ID: '13080674933',
  CLI_TARBALL: `propr-cli-${CLI_VERSION}.tgz`, CLI_TARBALL_SHA256: 'e'.repeat(64),
  LINUX_RELEASE_TAG: LINUX_TAG, LINUX_PUBLICATION: 'success', PLAN_LINUX: 'true',
  MACOS_RELEASE_TAG: MACOS_TAG, MACOS: 'skipped', PLAN_MACOS: 'false',
  DEMO_DEPLOY: 'skipped', TOKEN_CONFIGURED: 'false',
  ...overrides,
});
const facts = (overrides = {}, extra = {}) => ({
  ...inputsFromEnv(env(overrides)), publishedAt: '2026-11-25T10:00:00Z', demo: { status: 'stale', found: 'version "0.9.2"' }, ...extra,
});
const fixtures = [];
const fixture = () => { const dir = mkdtempSync(join(tmpdir(), 'release-followups-')); fixtures.push(dir); return dir; };
afterEach(() => { while (fixtures.length) rmSync(fixtures.pop(), { recursive: true, force: true }); });

describe('release follow-up texts', () => {
  test('a step is done when it succeeded or the plan skipped it because it is already published', () => {
    assert.equal(stepDone('success', 'true'), true);
    assert.equal(stepDone('skipped', 'false'), true);
    assert.equal(stepDone('skipped', 'true'), false, 'skipped after an earlier failure');
    assert.equal(stepDone('failure', 'true'), false);
    assert.equal(stepDone('cancelled', 'false'), false);
  });

  test('the ProPR Hosted repin lists the facts #178 needed', () => {
    const item = fleetFollowup(facts());
    assert.equal(item.ready, true);
    assert.equal(item.repository, 'integry/propr-fleet');
    assert.equal(item.title, 'Repin ProPR Hosted to ProPR 0.9.3');
    for (const fact of ['run **41300723460**', `artifact **\`propr-cli-preview-${SHA}-41300723460\`**`, 'artifact ID **13080674933**',
      `Tarball \`propr-cli-${CLI_VERSION}.tgz\`, sha256 \`${'e'.repeat(64)}\``, `CLI version \`${CLI_VERSION}\``,
      `gh run download 41300723460 -R integry/propr -n propr-cli-preview-${SHA}-41300723460`,
      `propr_expected_version: "0.9.3"`, `Source revision (the \`v0.9.3\` tag commit) \`${SHA}\``,
      ...Object.entries(images).map(([image, reference]) => `- ${image} \`${reference}\``)]) {
      assert.ok(item.body.includes(fact), fact);
    }
    assert.match(item.body, /Do not merge, deploy the executor/);
  });

  test('the repin is not ready without a prepared bundle or its facts', () => {
    assert.deepEqual(fleetFollowup(facts({ CLI_BUNDLE: 'failure' })),
      { key: 'fleet', repository: REPOSITORIES.fleet, title: 'Repin ProPR Hosted to ProPR 0.9.3', ready: false,
        reason: 'the preview CLI bundle is not available from this run' });
    assert.match(fleetFollowup(facts({ CLI_ARTIFACT_ID: '' })).reason, /artifact id/);
    assert.match(fleetFollowup(facts({ CLI_TARBALL_SHA256: 'nope' })).reason, /sha256/);
    assert.match(fleetFollowup(facts({ AGENT_IMAGE: '' })).reason, /agent image/);
  });

  test('the site follow-up carries published_at and both desktop pre-release tags', () => {
    const item = siteFollowup(facts());
    assert.equal(item.ready, true);
    assert.equal(item.repository, 'integry/propr-site');
    assert.ok(item.body.includes('`"0.9.3": "2026-11-25T10:00:00Z",`'));
    assert.ok(item.body.includes(`desktopRelease<"deb" | "rpm">("linux", "0.9.3", "${LINUX_TAG}")`));
    assert.ok(item.body.includes(`desktopRelease<"dmg" | "zip">("macos", "0.9.3", "${MACOS_TAG}")`));
    assert.ok(item.body.includes('release-site-src/src/data/follow.ts') && item.body.includes('release-site-src/src/data/releases.ts'));
    // The desktop app has its own version.
    assert.ok(siteFollowup(facts({ DESKTOP_VERSION: '0.9.4' })).body.includes(`("linux", "0.9.4", "${LINUX_TAG}")`));
  });

  test('the site follow-up waits for the release date and both desktop pre-releases', () => {
    assert.match(siteFollowup(facts({}, { publishedAt: undefined })).reason, /no published_at/);
    assert.match(siteFollowup(facts({}, { publishedAt: undefined, publishedAtUnavailable: 'it is still a draft' })).reason, /no published_at \(it is still a draft\)$/);
    assert.match(siteFollowup(facts({ LINUX_PUBLICATION: 'failure' })).reason, /signed Linux/);
    assert.match(siteFollowup(facts({ MACOS: 'skipped', PLAN_MACOS: 'true' })).reason, /macOS/);
    assert.equal(siteFollowup(facts({ LINUX_PUBLICATION: 'skipped', PLAN_LINUX: 'false' })).ready, true);
  });

  test('the demo follow-up names the deploy.env pins, and is not needed when the demo runs the release', () => {
    const item = demoFollowup(facts());
    assert.equal(item.ready, true);
    assert.equal(item.repository, 'integry/propr-deploy');
    assert.equal(item.title, 'Move demo.propr.dev to ProPR 0.9.3');
    assert.match(item.body, /reports version "0\.9\.2"/);
    assert.ok(item.body.includes('`DEMO_API_IMAGE=propr/app:0.9.3`') && item.body.includes('`DEMO_UI_IMAGE=propr/ui:0.9.3`'));
    assert.match(item.body, /DEPLOY_HOST`, `DEPLOY_USER` and `DEPLOY_SSH_KEY`/);
    assert.doesNotMatch(item.body, /started the deploy-on-release step/);
  });

  test('a deploy the run started is not done: the demo issue is still written and says to check that deploy', () => {
    const { unit, log } = demoDeploy('0.9.3');
    assert.deepEqual({ unit, log }, { unit: 'propr-release-deploy-0.9.3', log: '/root/propr-deploy/logs/release-deploy-0.9.3.log' });
    const started = inputsFromEnv(env({ DEMO_DEPLOY: 'started' }));
    assert.equal(started.demoDeployStarted, true);
    for (const result of ['skipped', 'failure', 'success', '']) assert.equal(inputsFromEnv(env({ DEMO_DEPLOY: result })).demoDeployStarted, false, result);
    const item = demoFollowup({ ...facts(), demo: { status: 'stale', found: 'version "0.9.2"', deployStarted: true } });
    assert.equal(item.ready, true);
    assert.equal(item.title, 'Move demo.propr.dev to ProPR 0.9.3');
    assert.match(item.body, /Release Rollout started the deploy-on-release step on the server/);
    assert.match(item.body, /did not wait for it/);
    assert.ok(item.body.includes(`systemd unit \`${unit}\``) && item.body.includes(`log \`${log}\``));
    assert.ok(item.body.includes(`\`systemctl status ${unit}\``) && item.body.includes(`\`tail -n 50 ${log}\``));
    assert.match(item.body, /`DEMO_API_IMAGE=propr\/app:0\.9\.3`/, 'the manual steps stay for a deploy that did not move the demo');
    assert.doesNotMatch(item.body, /To make this automatic/);
    assert.equal(demoFollowup({ ...facts(), demo: { status: 'ok', found: 'version 0.9.3', deployStarted: true } }).ready, false,
      'only the demo reporting the release makes the issue unnecessary');
    assert.deepEqual(demoFollowup(facts({}, { demo: { status: 'ok', found: 'version 0.9.3' } })),
      { key: 'demo', repository: REPOSITORIES.demo, title: 'Move demo.propr.dev to ProPR 0.9.3', ready: false,
        reason: 'demo.propr.dev already reports 0.9.3', done: true });
  });

  test('the summary prints the exact texts to file by hand when the token is not set', () => {
    const items = followups(facts({ CLI_BUNDLE: 'failure' }));
    const summary = followupsSummary({ version: '0.9.3', items, tokenConfigured: false });
    assert.match(summary, /### Release follow-ups for ProPR 0\.9\.3/);
    assert.match(summary, /\| `integry\/propr-fleet` \| Repin ProPR Hosted to ProPR 0\.9\.3 \| not ready: the preview CLI bundle/);
    assert.match(summary, /\| `integry\/propr-site` \| .* \| \*\*file by hand\*\* \(text below\) \|/);
    assert.ok(summary.includes(`\`${TOKEN_SECRET}\` is not set`));
    for (const item of items.filter(entry => entry.ready)) assert.ok(summary.includes(`~~~~markdown\n${item.body}\n~~~~`));
    assert.match(summary, /npm run release:rollout -- --version 0\.9\.3/);
    const filed = followupsSummary({ version: '0.9.3', items, tokenConfigured: true });
    assert.doesNotMatch(filed, /is not set/);
    assert.match(filed, /filed below/);
  });

  test('issues.tsv lists only the ready follow-ups', () => {
    const items = followups(facts({}, { demo: { status: 'ok', found: 'version 0.9.3' } }));
    assert.equal(issuesTsv(items, '/out'), [
      'integry/propr-fleet\tRepin ProPR Hosted to ProPR 0.9.3\t/out/fleet.md\n',
      'integry/propr-site\tSite: publication date and desktop downloads for ProPR 0.9.3\t/out/site.md\n',
    ].join(''));
  });

  test('the environment must name one release, a tag commit and a run', () => {
    assert.throws(() => inputsFromEnv(env({ RELEASE_TAG: 'v0.9.2' })), /one release/);
    assert.throws(() => inputsFromEnv(env({ SOURCE_REVISION: 'abc' })), /SOURCE_REVISION/);
    assert.throws(() => inputsFromEnv(env({ RUN_ID: '' })), /RUN_ID/);
    assert.equal(inputsFromEnv(env({ TOKEN_CONFIGURED: 'true', DEMO_DEPLOY: 'started' })).tokenConfigured, true);
  });

  test('published_at comes from the published GitHub release only', async () => {
    const reply = (status, body) => async () => ({ status, ok: status === 200, json: async () => body });
    const url = 'https://api.github.com/repos/integry/propr/releases/tags/v0.9.3';
    assert.deepEqual(await releasePublishedAt({ releaseTag: 'v0.9.3', fetchImpl: reply(200, { draft: false, published_at: 'T' }) }), { publishedAt: 'T' });
    assert.deepEqual(await releasePublishedAt({ releaseTag: 'v0.9.3', fetchImpl: reply(200, { draft: true, published_at: null }) }), { unavailable: 'it is still a draft' });
    assert.deepEqual(await releasePublishedAt({ releaseTag: 'v0.9.3', fetchImpl: reply(404, {}) }), { unavailable: `GET ${url} returned HTTP 404` });
  });

  test('a failed request or an unparsable body is an unavailable published_at, not a rejection', async () => {
    const refused = async () => { throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }); };
    const notJson = async () => ({ status: 200, ok: true, json: async () => { throw new SyntaxError('Unexpected token < in JSON'); } });
    assert.match((await releasePublishedAt({ releaseTag: 'v0.9.3', fetchImpl: refused })).unavailable, /failed: fetch failed \(ECONNRESET\)$/);
    assert.match((await releasePublishedAt({ releaseTag: 'v0.9.3', fetchImpl: notJson })).unavailable, /failed: Unexpected token < in JSON$/);
  });

  for (const [name, github] of [
    ['a connection failure', async () => { throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }); }],
    ['a body that is not JSON', async () => ({ status: 200, ok: true, json: async () => { throw new SyntaxError('Unexpected token < in JSON'); } })],
  ]) {
    test(`prepare still writes the fleet and demo follow-ups and the summary after ${name} on the GitHub release`, async () => {
      const dir = fixture();
      const out = join(dir, 'out');
      const summaryFile = join(dir, 'summary.md');
      const fetchImpl = async url => (url.startsWith('https://api.github.com/') ? github()
        : { status: 200, ok: true, text: async () => JSON.stringify({ version: '0.9.2' }) });
      const printed = [];
      const items = await prepare({ env: env({ GITHUB_STEP_SUMMARY: summaryFile }), out, fetchImpl, stdout: text => printed.push(text) });
      assert.deepEqual(items.map(item => [item.key, item.ready]), [['fleet', true], ['site', false], ['demo', true]]);
      assert.match(items[1].reason, /no published_at \(GET https:\/\/api\.github\.com\/\S+ failed: /);
      assert.equal(readFileSync(join(out, 'fleet.md'), 'utf8'), `${items[0].body}\n`);
      assert.equal(readFileSync(join(out, 'demo.md'), 'utf8'), `${items[2].body}\n`);
      assert.equal(existsSync(join(out, 'site.md')), false);
      assert.deepEqual(readFileSync(join(out, 'issues.tsv'), 'utf8').split('\n').filter(Boolean).map(line => line.split('\t')[0]),
        [REPOSITORIES.fleet, REPOSITORIES.demo]);
      const summary = readFileSync(summaryFile, 'utf8');
      assert.equal(summary, printed.join(''));
      assert.match(summary, /not ready: the GitHub release v0\.9\.3 has no published_at \(GET /);
      assert.match(summary, /is not set, so nothing was filed\. Open each issue below by hand/);
      assert.ok(summary.includes(items[0].body) && summary.includes(items[2].body));
    });
  }

  test('prepare writes the bodies, issues.tsv and the summary from the two public reads', async () => {
    const dir = fixture();
    const out = join(dir, 'out');
    const summaryFile = join(dir, 'summary.md');
    const urls = [];
    const fetchImpl = async url => {
      urls.push(url);
      if (url.startsWith('https://api.github.com/')) return { status: 200, ok: true, json: async () => ({ draft: false, published_at: '2026-11-25T10:00:00Z' }) };
      return { status: 200, ok: true, text: async () => JSON.stringify({ version: '0.9.2' }) };
    };
    const printed = [];
    const items = await prepare({ env: env({ GITHUB_STEP_SUMMARY: summaryFile }), out, fetchImpl, stdout: text => printed.push(text) });
    assert.deepEqual(urls.sort(), ['https://api.github.com/repos/integry/propr/releases/tags/v0.9.3', 'https://demo.propr.dev/api/status']);
    assert.deepEqual(items.map(item => [item.key, item.ready]), [['fleet', true], ['site', true], ['demo', true]]);
    assert.equal(readFileSync(join(out, 'demo.md'), 'utf8'), `${items[2].body}\n`);
    assert.equal(readFileSync(join(out, 'issues.tsv'), 'utf8').split('\n').filter(Boolean).length, 3);
    assert.equal(readFileSync(summaryFile, 'utf8'), printed.join(''));
    await assert.rejects(prepare({ env: env(), out, fetchImpl }), /new directory/);
  });
});

describe('Release Rollout follow-ups job contract', () => {
  const workflow = parse(readFileSync('.github/workflows/release-rollout.yml', 'utf8'));
  const job = workflow.jobs.followups;
  const step = name => job.steps.find(candidate => candidate.name.startsWith(name));
  const cli = parse(readFileSync('.github/workflows/preview-cli-bundle.yml', 'utf8'));

  test('runs last, after the desktop chain and the summary, for every planned run', () => {
    assert.deepEqual(job.needs, ['plan', 'runtime', 'linux-publication', 'macos', 'cli-bundle', 'summary']);
    assert.equal(job.if, "${{ always() && needs.plan.result == 'success' }}");
    assert.deepEqual(job.permissions, { contents: 'read' });
    assert.equal(job.environment, undefined);
    for (const name of Object.keys(workflow.jobs)) {
      if (name !== 'followups') assert.ok(![workflow.jobs[name].needs ?? []].flat().includes('followups'), name);
    }
  });

  test('passes the chain outputs the texts need, and the token only as a yes/no', () => {
    const texts = step('Write the follow-up texts');
    assert.equal(texts.run, 'node scripts/release-followups.mjs prepare --out "$RUNNER_TEMP/release-followups"');
    for (const name of Object.keys(env())) assert.ok(name in texts.env, name);
    assert.equal(texts.env.TOKEN_CONFIGURED, "${{ secrets.RELEASE_FOLLOWUP_ISSUES_TOKEN != '' }}");
    assert.equal(texts.env.DEMO_DEPLOY, '${{ steps.demo.outputs.result }}');
    for (const output of ['cli_version', 'artifact_name', 'artifact_id', 'tarball', 'tarball_sha256']) {
      assert.ok(Object.values(texts.env).includes(`\${{ needs.cli-bundle.outputs.${output} }}`), output);
      assert.equal(cli.on.workflow_call.outputs[output].value, `\${{ jobs.prepare.outputs.${output} }}`, output);
      assert.ok(cli.jobs.prepare.outputs[output], output);
    }
    assert.equal(cli.jobs.prepare.outputs.artifact_id, '${{ steps.upload.outputs.artifact-id }}');
    const upload = cli.jobs.prepare.steps.find(candidate => candidate.id === 'upload');
    assert.equal(cli.jobs.prepare.outputs.artifact_name, upload.with.name, 'the artifact name is the uploaded one');
    for (const output of ['desktop_version', 'linux_release_tag', 'macos_release_tag']) {
      assert.equal(workflow.jobs.plan.outputs[output], `\${{ steps.plan.outputs.${output} }}`, output);
    }
    for (const candidate of job.steps) {
      if (candidate !== step('Open the follow-up issues')) assert.doesNotMatch(JSON.stringify(candidate), /secrets\.RELEASE_FOLLOWUP_ISSUES_TOKEN }}/);
    }
  });

  const runStep = (name, stepEnv, path = process.env.PATH) => {
    const dir = fixture();
    const files = { GITHUB_OUTPUT: join(dir, 'output'), GITHUB_STEP_SUMMARY: join(dir, 'summary.md') };
    const result = spawnSync('bash', ['-c', step(name).run], { encoding: 'utf8', env: { PATH: path, RUNNER_TEMP: dir, ...files, ...stepEnv } });
    const read = file => (existsSync(file) ? readFileSync(file, 'utf8') : '');
    return { ...result, dir, output: read(files.GITHUB_OUTPUT), summary: read(files.GITHUB_STEP_SUMMARY) };
  };

  test('without the deploy-on-release secrets the demo step succeeds and deploys nothing', () => {
    const result = runStep('Start the demo deploy', { VERSION: '0.9.3', DEPLOY_HOST: '', DEPLOY_USER: 'deploy', DEPLOY_SSH_KEY: '' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.output, 'result=skipped\n');
    assert.equal(result.summary, '');
    assert.equal(step('Start the demo deploy').env.VERSION, '${{ needs.plan.outputs.version }}');
  });

  // A fake ssh that records its arguments and exits with the given status, without reading stdin.
  const fakeSsh = status => {
    const dir = fixture();
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const log = join(dir, 'ssh.log');
    writeFileSync(join(bin, 'ssh'), `#!/bin/bash\nprintf '%s\\n' "$@" > '${log}'\nexit ${status}\n`);
    chmodSync(join(bin, 'ssh'), 0o755);
    return { path: `${bin}:${process.env.PATH}`, args: () => readFileSync(log, 'utf8').trimEnd().split('\n') };
  };
  const secrets = { VERSION: '0.9.3', DEPLOY_HOST: 'demo.example', DEPLOY_USER: 'root', DEPLOY_SSH_KEY: 'not-a-real-key' };

  test('with the secrets it starts the deploy detached on the host, returns at once and says where the log is', () => {
    const ssh = fakeSsh(0);
    const result = runStep('Start the demo deploy', secrets, ssh.path);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.output, 'result=started\n');
    const args = ssh.args();
    for (const option of ['BatchMode=yes', 'ConnectTimeout=30', 'ServerAliveInterval=30', 'ServerAliveCountMax=4']) {
      assert.equal(args[args.indexOf(option) - 1], '-o', option);
    }
    assert.ok(args.includes('root@demo.example'));
    const { unit, log } = demoDeploy('0.9.3');
    const remote = args.at(-1);
    assert.equal(remote, `mkdir -p /root/propr-deploy/logs && systemd-run --unit=${unit} --collect --setenv=HOME=/root`
      + ` --working-directory=/root/propr-deploy --property=StandardOutput=append:${log} --property=StandardError=append:${log}`
      + ' /root/propr-deploy/scripts/deploy.sh all');
    assert.doesNotMatch(remote, /--wait|--pty|journalctl|tail/, 'the step does not wait for the deploy');
    assert.ok(!existsSync(join(result.dir, 'deploy-on-release-key')), 'the key is removed');
    assert.match(result.summary, /#### Demo deploy/);
    assert.ok(result.summary.includes(`systemd unit \`${unit}\`; this run does not wait for it`));
    assert.ok(result.summary.includes(`Its log is \`${log}\` on the host`));
  });

  test('a failed start is a warning, not a failed step', () => {
    const ssh = fakeSsh(1);
    const result = runStep('Start the demo deploy', secrets, ssh.path);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.output, 'result=failure\n');
    assert.match(result.stdout, /::warning::The deploy-on-release SSH step could not start propr-release-deploy-0\.9\.3/);
    assert.equal(result.summary, '');
    const bad = runStep('Start the demo deploy', { ...secrets, VERSION: '0.9.3; reboot' }, fakeSsh(0).path);
    assert.equal(bad.status, 0, bad.stderr);
    assert.equal(bad.output, 'result=failure\n');
  });

  test('without the token the issue step succeeds and files nothing', () => {
    const result = runStep('Open the follow-up issues', { GH_TOKEN: '', FOLLOWUPS: '/nonexistent' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /RELEASE_FOLLOWUP_ISSUES_TOKEN is not set/);
    assert.equal(result.summary, '');
  });

  test('with the token it files each ready follow-up once and skips one with the same title', () => {
    const dir = fixture();
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const log = join(dir, 'gh.log');
    // A fake gh: integry/propr-site already has the issue (closed), the others do not.
    writeFileSync(join(bin, 'gh'), `#!/usr/bin/env bash
echo "$*" >> ${JSON.stringify(log)}
if [ "$1 $2" = "issue list" ]; then
  # gh --jq picks the exact title (env.ISSUE_TITLE) from the search results.
  if [ "$4" = integry/propr-site ] && [ "$ISSUE_TITLE" = 'Site: x' ]; then echo 'https://github.com/integry/propr-site/issues/9'; fi
else
  echo "https://github.com/$4/issues/1"
fi
`);
    chmodSync(join(bin, 'gh'), 0o755);
    const followupsDir = join(dir, 'followups');
    mkdirSync(followupsDir);
    writeFileSync(join(followupsDir, 'issues.tsv'), [
      `integry/propr-fleet\tRepin ProPR Hosted to ProPR 0.9.3\t${followupsDir}/fleet.md`,
      `integry/propr-site\tSite: x\t${followupsDir}/site.md`, '',
    ].join('\n'));
    const result = runStep('Open the follow-up issues', { GH_TOKEN: 'token', FOLLOWUPS: followupsDir }, `${bin}:${process.env.PATH}`);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.summary, /- `integry\/propr-fleet`: opened https:\/\/github\.com\/integry\/propr-fleet\/issues\/1/);
    assert.match(result.summary, /- `integry\/propr-site`: already filed: https:\/\/github\.com\/integry\/propr-site\/issues\/9/);
    const calls = readFileSync(log, 'utf8').trim().split('\n');
    assert.ok(calls.includes('issue list -R integry/propr-site --state all --search "Site: x" in:title --json title,url '
      + '--jq map(select(.title == env.ISSUE_TITLE))[0].url // empty'));
    assert.equal(calls.filter(call => call.startsWith('issue create')).length, 1);
    assert.ok(calls.includes(`issue create -R integry/propr-fleet --title Repin ProPR Hosted to ProPR 0.9.3 --body-file ${followupsDir}/fleet.md`));
  });
});
