#!/usr/bin/env node
// Release follow-ups outside this repository, written at the end of Release
// Rollout (.github/workflows/release-rollout.yml):
//
//   integry/propr-fleet   repin ProPR Hosted to the release's preview CLI bundle
//   integry/propr-site    the release's published_at and the desktop pre-release tags
//   integry/propr-deploy  move demo.propr.dev to the release (unless it already runs it)
//
//   node scripts/release-followups.mjs prepare --out <new directory>
//
// The texts are pure functions of the chain's outputs (see the env names in
// `inputsFromEnv`), so they are unit-tested. `prepare` reads two public facts
// (the GitHub release's published_at and the demo's /api/status), writes one
// Markdown body per follow-up to <out>/<key>.md, lists the ones that are ready
// to file in <out>/issues.tsv (repository, title, body file) and writes the run
// summary. It never writes to another repository: the workflow files the
// issues with `gh issue create` when RELEASE_FOLLOWUP_ISSUES_TOKEN is set, and
// otherwise the summary says to file the printed texts by hand.

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkStatusJson } from './lib/release-rollout/web.mjs';
import { TARGETS } from './verify-release-rollout.mjs';

export const TOKEN_SECRET = 'RELEASE_FOLLOWUP_ISSUES_TOKEN';
export const REPOSITORIES = Object.freeze({
  fleet: 'integry/propr-fleet',
  site: 'integry/propr-site',
  demo: 'integry/propr-deploy',
});
const SOURCE_REPOSITORY = 'integry/propr';
const SHA = /^[0-9a-f]{40}$/;
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const IMAGES = Object.freeze(['app', 'ui', 'agent']);
const DEMO_TARGET = TARGETS.find(target => target.id === 'demo');

const runUrl = runId => `https://github.com/${SOURCE_REPOSITORY}/actions/runs/${runId}`;
const releaseUrl = tag => `https://github.com/${SOURCE_REPOSITORY}/releases/tag/${tag}`;
const footer = runId => [
  '',
  '---',
  `Opened by Release Rollout run [${runId}](${runUrl(runId)}) (\`scripts/release-followups.mjs\`).`,
];

/** A job step that finished: it ran and succeeded, or the plan skipped it because its artefact exists. */
export const stepDone = (result, planned) => result === 'success' || (result === 'skipped' && planned === 'false');

/** Repin ProPR Hosted (integry/propr-fleet), with the facts integry/propr-fleet#178 listed. */
export function fleetFollowup(facts) {
  const { version, releaseTag, sourceRevision, runId, bundle, images } = facts;
  const title = `Repin ProPR Hosted to ProPR ${version}`;
  const missingFact = [
    ['the preview CLI bundle', bundle?.result === 'success'],
    ['the bundle artifact name', bundle?.artifactName],
    ['the bundle artifact id', bundle?.artifactId],
    ['the bundle tarball', bundle?.tarball],
    ['the bundle tarball sha256', /^[0-9a-f]{64}$/.test(bundle?.tarballSha256 ?? '')],
    ...IMAGES.map(image => [`the ${image} image`, images?.[image]]),
  ].find(([, present]) => !present);
  if (missingFact) return { key: 'fleet', repository: REPOSITORIES.fleet, title, ready: false, reason: `${missingFact[0]} is not available from this run` };
  const body = [
    `Repin ProPR Hosted to ProPR ${version} ([\`${releaseTag}\`](${releaseUrl(releaseTag)})) using the internal-preview shape, from the Preview CLI Bundle that Release Rollout prepared for the tag commit. Check current upstream main first; follow \`runbooks/upgrade-rollback.md\` the way the previous repin (#178) did.`,
    '',
    '## Preview CLI bundle',
    '',
    `- integry/propr Release Rollout run **${runId}** (${runUrl(runId)}), artifact **\`${bundle.artifactName}\`**, artifact ID **${bundle.artifactId}** (retained 60 days).`,
    `- Download and re-verify it yourself: \`gh run download ${runId} -R ${SOURCE_REPOSITORY} -n ${bundle.artifactName}\`, then \`sha256sum -c SHA256SUMS\`.`,
    `- Tarball \`${bundle.tarball}\`, sha256 \`${bundle.tarballSha256}\`.`,
    ...(bundle.cliVersion ? [`- CLI version \`${bundle.cliVersion}\`.`] : []),
    `- Source revision (the \`${releaseTag}\` tag commit) \`${sourceRevision}\`.`,
    '',
    '## Runtime images',
    '',
    ...IMAGES.map(image => `- ${image} \`${images[image]}\``),
    '',
    '## Steps',
    '',
    `1. group_vars selection in \`ansible/playbooks/group_vars/all.yml\` (\`propr_cli_version\`, \`propr_expected_version: "${version}"\`, \`propr_preview\` artifact_dir/sha256/source_revision/images) and its comment.`,
    '2. The selected-public-artifact pins (`scripts/public-artifacts/custody.py`, `assemble.py`), their consistency test and `docs/selected-public-artifacts.md`.',
    `3. Add \`${sourceRevision}\` to the restore drill's reviewed preview sources and anything else that lists preview sources.`,
    '4. Launcher fixture, runbooks, test fixtures, and any routing pin that must move together; say so explicitly if a Routing-pinned file changes.',
    '5. Run the full test suite and fix fixture drift.',
    '6. PR body: the remaining operator steps with commands (retain the artifact files on the controller, restore drill on a staging tenant, executor deploy, canary reconcile, batch rollout, rollback to the previous pins).',
    '',
    'One PR ready for review. Do not merge, deploy the executor, reconcile or roll out any tenant, and do not dispatch workflows.',
    ...footer(runId),
  ].join('\n');
  return { key: 'fleet', repository: REPOSITORIES.fleet, title, ready: true, body };
}

/** The release date and the desktop pre-release tags on propr.dev (integry/propr-site). */
export function siteFollowup(facts) {
  const { version, releaseTag, runId, publishedAt, desktopVersion, desktop } = facts;
  const title = `Site: publication date and desktop downloads for ProPR ${version}`;
  const reason = !publishedAt ? `the GitHub release ${releaseTag} has no published_at`
    : !desktop?.linux?.done ? 'the signed Linux desktop pre-release is not published by this run'
      : !desktop?.macos?.done ? 'the macOS desktop pre-release is not published by this run'
        : undefined;
  if (reason) return { key: 'site', repository: REPOSITORIES.site, title, ready: false, reason };
  const body = [
    `ProPR ${version} ([\`${releaseTag}\`](${releaseUrl(releaseTag)})) is published, and Release Rollout published its desktop pre-releases. Update the site data:`,
    '',
    `1. \`release-site-src/src/data/follow.ts\`: add \`"${version}": "${publishedAt}",\` at the top of \`publishedAt\` (the GitHub release's \`published_at\`).`,
    `2. \`release-site-src/src/data/releases.ts\`: point the desktop downloads at desktop version \`${desktopVersion}\`:`,
    '',
    '   ```ts',
    `   const linux = desktopRelease<"deb" | "rpm">("linux", "${desktopVersion}", "${desktop.linux.tag}");`,
    `   const macos = desktopRelease<"dmg" | "zip">("macos", "${desktopVersion}", "${desktop.macos.tag}");`,
    '   ```',
    '',
    `   - Linux (signed): ${releaseUrl(desktop.linux.tag)}`,
    `   - macOS: ${releaseUrl(desktop.macos.tag)}`,
    '',
    `Afterwards \`npm run release:rollout -- --version ${version}\` in integry/propr reports \`site:download\` and \`site:whats-new\` as \`ok\` once the site is deployed.`,
    ...footer(runId),
  ].join('\n');
  return { key: 'site', repository: REPOSITORIES.site, title, ready: true, body };
}

/** Move demo.propr.dev (integry/propr-deploy) to the release, unless it already reports it. */
export function demoFollowup(facts) {
  const { version, releaseTag, runId, demo = {} } = facts;
  const title = `Move demo.propr.dev to ProPR ${version}`;
  if (demo.status === 'ok') {
    return { key: 'demo', repository: REPOSITORIES.demo, title, ready: false, reason: `demo.propr.dev already reports ${version}`, done: true };
  }
  const body = [
    `ProPR ${version} ([\`${releaseTag}\`](${releaseUrl(releaseTag)})) is published, but ${DEMO_TARGET.url} reports ${demo.found ?? 'an older version'}.`,
    ...(demo.deployed ? ['', 'Release Rollout ran the deploy-on-release SSH step (`./scripts/deploy.sh all`), and the demo still does not report this version.'] : []),
    '',
    'On the dedicated server:',
    '',
    `1. In the host-only \`deploy.env\`, set \`DEMO_API_IMAGE=propr/app:${version}\` and \`DEMO_UI_IMAGE=propr/ui:${version}\` (or remove both pins so the demo follows \`IMAGE_TAG\`/\`latest\`). A pin left at an older version keeps the daily refresh on it.`,
    '2. Run `./scripts/deploy.sh demo`.',
    `3. Check \`curl -s ${DEMO_TARGET.url}\` reports \`"version":"${version}"\`, or run \`npm run release:rollout -- --version ${version}\` in integry/propr.`,
    '',
    'To make this automatic, `DEPLOYMENT.md` describes the deploy-on-release step: set `DEPLOY_HOST`, `DEPLOY_USER` and `DEPLOY_SSH_KEY` as integry/propr repository secrets and Release Rollout runs it.',
    ...footer(runId),
  ].join('\n');
  return { key: 'demo', repository: REPOSITORIES.demo, title, ready: true, body };
}

export const followups = facts => [fleetFollowup(facts), siteFollowup(facts), demoFollowup(facts)];

/** The run summary: each follow-up, its state and, when it is to be filed by hand, its exact text. */
export function followupsSummary({ version, items, tokenConfigured }) {
  const state = item => (item.ready ? (tokenConfigured ? 'filed below (unless it already exists)' : '**file by hand** (text below)')
    : item.done ? `not needed: ${item.reason}` : `not ready: ${item.reason}`);
  const lines = [
    `### Release follow-ups for ProPR ${version}`,
    '',
    '| Repository | Follow-up | State |',
    '| --- | --- | --- |',
    ...items.map(item => `| \`${item.repository}\` | ${item.title} | ${state(item)} |`),
    '',
  ];
  if (!tokenConfigured && items.some(item => item.ready)) {
    lines.push(`\`${TOKEN_SECRET}\` is not set, so nothing was filed. Open each issue below by hand (title, then body):`, '');
  }
  for (const item of items.filter(entry => entry.ready)) {
    lines.push(`<details${tokenConfigured ? '' : ' open'}><summary>${item.repository}: ${item.title}</summary>`, '', '~~~~markdown', item.body, '~~~~', '', '</details>', '');
  }
  lines.push(`Last step: \`npm run release:rollout -- --version ${version}\`.`, '');
  return lines.join('\n');
}

export const issuesTsv = (items, out) => items.filter(item => item.ready).map(item => {
  if (/[\t\r\n]/.test(item.title + item.repository)) throw new Error(`Follow-up ${item.key} has a tab or newline in its title`);
  return `${item.repository}\t${item.title}\t${join(out, `${item.key}.md`)}\n`;
}).join('');

/** The chain's outputs, from the follow-ups job environment. */
export function inputsFromEnv(env) {
  const version = env.VERSION;
  if (!VERSION.test(version ?? '') || env.RELEASE_TAG !== `v${version}`) throw new Error('VERSION and RELEASE_TAG must name one release');
  if (!SHA.test(env.SOURCE_REVISION ?? '')) throw new Error('SOURCE_REVISION must be a full lowercase commit SHA');
  if (!/^\d+$/.test(env.RUN_ID ?? '')) throw new Error('RUN_ID must be the workflow run id');
  return {
    version,
    releaseTag: env.RELEASE_TAG,
    sourceRevision: env.SOURCE_REVISION,
    runId: env.RUN_ID,
    desktopVersion: env.DESKTOP_VERSION,
    images: { app: env.APP_IMAGE, ui: env.UI_IMAGE, agent: env.AGENT_IMAGE },
    bundle: {
      result: env.CLI_BUNDLE,
      cliVersion: env.CLI_VERSION,
      artifactName: env.CLI_ARTIFACT_NAME,
      artifactId: env.CLI_ARTIFACT_ID,
      tarball: env.CLI_TARBALL,
      tarballSha256: env.CLI_TARBALL_SHA256,
    },
    desktop: {
      linux: { tag: env.LINUX_RELEASE_TAG, done: Boolean(env.LINUX_RELEASE_TAG) && stepDone(env.LINUX_PUBLICATION, env.PLAN_LINUX) },
      macos: { tag: env.MACOS_RELEASE_TAG, done: Boolean(env.MACOS_RELEASE_TAG) && stepDone(env.MACOS, env.PLAN_MACOS) },
    },
    demoDeployed: env.DEMO_DEPLOY === 'success',
    tokenConfigured: env.TOKEN_CONFIGURED === 'true',
  };
}

/** published_at of the GitHub release, or undefined when it is not a published release. */
export async function releasePublishedAt({ releaseTag, token, fetchImpl = fetch }) {
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetchImpl(`https://api.github.com/repos/${SOURCE_REPOSITORY}/releases/tags/${encodeURIComponent(releaseTag)}`, { headers });
  if (!response.ok) return undefined;
  const release = await response.json();
  return release?.draft === false && typeof release.published_at === 'string' ? release.published_at : undefined;
}

export async function prepare({ env, out, fetchImpl = fetch, stdout = text => process.stdout.write(text) }) {
  if (!out || existsSync(out)) throw new Error('--out must name a new directory');
  const input = inputsFromEnv(env);
  const [publishedAt, demo] = await Promise.all([
    releasePublishedAt({ releaseTag: input.releaseTag, token: env.GITHUB_TOKEN, fetchImpl }),
    checkStatusJson({ version: input.version, fetchImpl, cache: new Map() }, DEMO_TARGET),
  ]);
  const items = followups({ ...input, publishedAt, demo: { ...demo, deployed: input.demoDeployed } });
  mkdirSync(out, { recursive: true });
  for (const item of items.filter(entry => entry.ready)) writeFileSync(join(out, `${item.key}.md`), `${item.body}\n`);
  writeFileSync(join(out, 'issues.tsv'), issuesTsv(items, out));
  const summary = followupsSummary({ version: input.version, items, tokenConfigured: input.tokenConfigured });
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, summary);
  stdout(summary);
  return items;
}

const main = async ([command, flag, out]) => {
  if (command !== 'prepare' || flag !== '--out') throw new Error('Usage: release-followups.mjs prepare --out <new directory>');
  await prepare({ env: process.env, out: resolve(out) });
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
