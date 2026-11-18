#!/usr/bin/env node
// Release rollout check: says, for one release, where it is live.
//
//   node scripts/verify-release-rollout.mjs --version 0.9.2 [--json]
//   npm run release:rollout -- --version 0.9.2
//
// Prints one line per target: `ok`, `missing` or `stale`, then what it found.
// Every read is a public, unauthenticated request; the check changes nothing.
// Exits 0 only when every target is `ok`. Inside GitHub Actions it also writes
// the results as a table to the run summary ($GITHUB_STEP_SUMMARY).
//
// Targets are data: add a release destination by adding one entry to TARGETS
// with a `kind` from scripts/lib/release-rollout/run.mjs (CHECKS).

import { appendFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isReleaseVersion } from './lib/hosted-ui-bundle.mjs';
import { allOk, formatJson, formatSummary, formatText, runRollout } from './lib/release-rollout/run.mjs';

const REPO = 'integry/propr';
const LINUX_PREVIEW = { prefix: 'desktop-linux-preview-v{version}-', suffix: '-all-signed' };
const MACOS_PREVIEW = { prefix: 'desktop-macos-preview-v{version}-' };
const dockerImage = repository => ({ id: `docker:${repository}`, kind: 'docker-image', repository });

export const TARGETS = Object.freeze([
  { id: 'github-release', kind: 'github-release', repo: REPO, summaryPath: 'release-notes/v{version}.md' },
  dockerImage('propr/app'),
  dockerImage('propr/ui'),
  dockerImage('propr/docs'),
  dockerImage('propr/agent'),
  { id: 'npm:propr-cli', kind: 'npm-package', package: 'propr-cli' },
  { id: 'hosted-ui', kind: 'hosted-ui-bundle', url: 'https://app.propr.dev/' },
  { id: 'demo', kind: 'status-json', url: 'https://demo.propr.dev/api/status', field: 'version' },
  {
    id: 'desktop:linux',
    kind: 'desktop-prerelease',
    repo: REPO,
    tagPrefix: LINUX_PREVIEW.prefix,
    tagSuffix: LINUX_PREVIEW.suffix,
    assets: [
      'ProPR-Desktop-{version}-linux-x64.deb',
      'ProPR-Desktop-{version}-linux-arm64.deb',
      'ProPR-Desktop-{version}-linux-x64.rpm',
      'ProPR-Desktop-{version}-linux-arm64.rpm',
      'linux-preview.json',
      'SHA256SUMS',
      'SHA256SUMS.asc',
    ],
  },
  {
    id: 'desktop:macos',
    kind: 'desktop-prerelease',
    repo: REPO,
    tagPrefix: MACOS_PREVIEW.prefix,
    assets: [
      'ProPR-Desktop-{version}-macos-arm64.dmg',
      'ProPR-Desktop-{version}-macos-x64.dmg',
      'ProPR-Desktop-{version}-macos-arm64.zip',
      'ProPR-Desktop-{version}-macos-x64.zip',
      'macos-preview.json',
      'SHA256SUMS',
    ],
  },
  { id: 'site:whats-new', kind: 'page', url: 'https://propr.dev/whats-new/{version}/' },
  { id: 'site:download', kind: 'page-links', url: 'https://propr.dev/desktop/', tagFamilies: [LINUX_PREVIEW, MACOS_PREVIEW] },
]);

const USAGE = 'Usage: node scripts/verify-release-rollout.mjs --version <x.y.z> [--json]';

export function parseArgs(argv) {
  const options = { json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--version') options.version = argv[++index];
    else if (arg.startsWith('--version=')) options.version = arg.slice('--version='.length);
    else throw new Error(`Unknown argument ${JSON.stringify(arg)}\n${USAGE}`);
  }
  if (options.help) return options;
  // Accept the tag form too: v0.9.2 is the release of 0.9.2.
  if (typeof options.version === 'string') options.version = options.version.replace(/^v(?=\d)/, '');
  if (!isReleaseVersion(options.version)) {
    throw new Error(`--version must be a release version such as 0.9.2, got ${JSON.stringify(options.version)}\n${USAGE}`);
  }
  return options;
}

export async function main({
  argv = process.argv.slice(2),
  env = process.env,
  fetchImpl = fetch,
  targets = TARGETS,
  repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  readFile,
  stdout = text => process.stdout.write(`${text}\n`),
  stderr = text => process.stderr.write(`${text}\n`),
  appendSummary = (file, text) => appendFileSync(file, text),
} = {}) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    stderr(error.message);
    return 2;
  }
  if (options.help) {
    stdout(USAGE);
    return 0;
  }
  const results = await runRollout({ targets, version: options.version, fetchImpl, repoRoot, readFile });
  stdout(options.json ? formatJson(options.version, results) : formatText(results));
  if (env.GITHUB_STEP_SUMMARY) appendSummary(env.GITHUB_STEP_SUMMARY, formatSummary(options.version, results));
  return allOk(results) ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exitCode = code; }, error => {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  });
}
