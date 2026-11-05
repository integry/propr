#!/usr/bin/env node
// Trusted-main gates for the prepare-only Preview CLI Bundle workflow.
//
// The workflow runs this file from its own reviewed main checkout (github.sha),
// never from the requested source checkout, so the trust, input and output
// checks below run before and independently of any source-revision code.
// Nothing here writes to a registry, npm, a release, or any remote.
//
//   trust         validate manual main dispatch, exact inputs and ancestry; write
//                 the schema-v1 preview input JSON
//   source-ready  validate the exact clean source checkout and pin its
//                 origin/main to the trusted workflow commit
//   verify-output validate the single completed preview directory; write step
//                 outputs and the fixed operator summary

import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPreviewPackage, validatePreviewInput } from '../packages/cli/scripts/preview-package.mjs';
import { sha256File } from './preview-runtime-images.mjs';

const SHA = /^[0-9a-f]{40}$/;
const REPOSITORY = 'integry/propr';
const CANONICAL_ORIGINS = ['https://github.com/integry/propr', 'https://github.com/integry/propr.git'];
const IMAGES = ['app', 'ui', 'agent'];

const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const isAncestor = (root, ancestor, descendant) =>
  spawnSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], { cwd: root, stdio: 'ignore' }).status === 0;

const requireSha = (value, label) => {
  if (typeof value !== 'string' || !SHA.test(value)) throw new Error(`${label} must be a full lowercase 40-character commit SHA`);
  return value;
};

const requireCanonicalCheckout = (root, head, label) => {
  if (!CANONICAL_ORIGINS.includes(git(root, ['remote', 'get-url', 'origin']))) {
    throw new Error(`${label} checkout origin must be the canonical ${REPOSITORY} repository`);
  }
  if (git(root, ['rev-parse', 'HEAD']) !== head) throw new Error(`${label} checkout HEAD does not match ${head}`);
};

export function validateDispatch({ eventName, ref, repository, trustedMain }) {
  if (eventName !== 'workflow_dispatch' || ref !== 'refs/heads/main') {
    throw new Error('Preview CLI preparation must be a manual workflow_dispatch from refs/heads/main');
  }
  if (repository !== REPOSITORY) throw new Error(`Preview CLI preparation must run in ${REPOSITORY}`);
  return requireSha(trustedMain, 'Trusted main (workflow run commit)');
}

export function buildPreviewInput({ sourceRevision, app, ui, agent }) {
  requireSha(sourceRevision, 'source_revision');
  // JSON.stringify of these exact strings: no shell interpolation is involved.
  return validatePreviewInput({ schemaVersion: 1, repository: REPOSITORY, sourceRevision, images: { app, ui, agent } });
}

export function trust({ eventName, ref, repository, trustedMain, sourceRevision, app, ui, agent, root, output, githubOutput }) {
  validateDispatch({ eventName, ref, repository, trustedMain });
  const input = buildPreviewInput({ sourceRevision, app, ui, agent });
  requireCanonicalCheckout(root, trustedMain, 'Trusted main');
  if (git(root, ['rev-parse', '--is-shallow-repository']) !== 'false') throw new Error('Trusted main checkout must have full history');
  if (!isAncestor(root, sourceRevision, trustedMain)) {
    throw new Error('source_revision must be the trusted main commit or one of its ancestors');
  }
  if (!output || existsSync(output)) throw new Error('Preview input output path must be new');
  writeFileSync(output, `${JSON.stringify(input, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  if (githubOutput) appendFileSync(githubOutput, `source_revision=${sourceRevision}\ntrusted_main=${trustedMain}\n`);
  return input;
}

export function sourceReady({ root, sourceRevision, trustedMain }) {
  requireSha(sourceRevision, 'source_revision');
  requireSha(trustedMain, 'Trusted main');
  requireCanonicalCheckout(root, sourceRevision, 'Source');
  if (git(root, ['status', '--porcelain', '--untracked-files=all'])) throw new Error('Source checkout must be clean');
  // The fetched canonical main must already contain the workflow commit; then
  // pin origin/main to that exact commit so the helper's own trust check binds
  // to the workflow run commit rather than whatever main has advanced to.
  if (!isAncestor(root, trustedMain, 'refs/remotes/origin/main')) {
    throw new Error('Fetched canonical origin/main does not contain the trusted main commit');
  }
  if (!isAncestor(root, sourceRevision, trustedMain)) {
    throw new Error('source_revision must be the trusted main commit or one of its ancestors');
  }
  git(root, ['update-ref', 'refs/remotes/origin/main', trustedMain]);
  if (git(root, ['rev-parse', 'refs/remotes/origin/main']) !== trustedMain) throw new Error('Could not pin origin/main');
}

const requireFile = path => {
  const details = lstatSync(path, { throwIfNoEntry: false });
  if (!details?.isFile() || details.isSymbolicLink()) throw new Error(`Preview output is incomplete: ${path}`);
};

export function verifyOutput({ root, input: inputPath, trustedMain, workspace = process.cwd() }) {
  requireSha(trustedMain, 'Trusted main');
  const input = validatePreviewInput(JSON.parse(readFileSync(inputPath, 'utf8')));
  const base = JSON.parse(readFileSync(join(root, 'packages/cli/package.json'), 'utf8')).version;
  if (!/^\d+\.\d+\.\d+$/.test(base)) throw new Error('Source CLI base version must be numeric stable semver');
  const previewRoot = join(root, 'dist-publish', 'preview');
  const entries = existsSync(previewRoot) ? readdirSync(previewRoot) : [];
  if (entries.length !== 1) throw new Error(`Expected exactly one completed preview directory, found ${entries.length}`);
  const [version] = entries;
  // Recompute the deterministic source/runtime-reference binding rather than
  // trusting any 64-hex suffix the build left behind.
  if (version !== createPreviewPackage(base, input).version) throw new Error(`Unexpected preview directory: ${version}`);
  const directory = join(previewRoot, version);
  const details = lstatSync(directory);
  if (!details.isDirectory() || details.isSymbolicLink()) throw new Error('Preview output must be a real directory');
  const tarball = `propr-cli-${version}.tgz`;
  const expected = [tarball, 'manifest.json', 'provenance.json', 'SHA256SUMS'];
  if (readdirSync(directory).sort().join('\n') !== [...expected].sort().join('\n')) {
    throw new Error(`Preview output must contain exactly ${expected.join(', ')}`);
  }
  for (const file of expected) requireFile(join(directory, file));

  const hashes = Object.fromEntries(expected.slice(0, 3).map(file => [file, sha256File(join(directory, file))]));
  const sums = expected.slice(0, 3).map(file => `${hashes[file]}  ${file}\n`).join('');
  if (readFileSync(join(directory, 'SHA256SUMS'), 'utf8') !== sums) throw new Error('SHA256SUMS does not match the preview files');
  const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
  const provenance = JSON.parse(readFileSync(join(directory, 'provenance.json'), 'utf8'));
  if (manifest.version !== version || manifest.git_sha !== input.sourceRevision
    || IMAGES.some(image => manifest.images?.[image] !== input.images[image]) || manifest.images?.docs !== undefined) {
    throw new Error('Preview manifest does not bind the exact version, source and runtime references');
  }
  if (provenance.repository !== REPOSITORY || provenance.sourceRevision !== input.sourceRevision
    || provenance.trustedMain !== trustedMain || provenance.cliVersion !== version
    || IMAGES.some(image => provenance.images?.[image]?.reference !== input.images[image])
    || provenance.files?.[tarball] !== hashes[tarball] || provenance.files?.['manifest.json'] !== hashes['manifest.json']) {
    throw new Error('Preview provenance does not bind the exact version, source, trusted main and files');
  }
  return {
    version, sourceRevision: input.sourceRevision, trustedMain, tarball, images: input.images,
    artifactPath: relative(workspace, directory), tarballSha256: hashes[tarball],
    manifestSha256: hashes['manifest.json'], provenanceSha256: hashes['provenance.json'],
  };
}

export function operatorSummary(result) {
  return [
    '### Preview CLI bundle prepared (prepare-only)',
    '',
    '| Field | Value |',
    '| --- | --- |',
    `| CLI version | \`${result.version}\` |`,
    `| Source revision | \`${result.sourceRevision}\` |`,
    `| Trusted main revision | \`${result.trustedMain}\` |`,
    `| Tarball | \`${result.tarball}\` |`,
    `| Tarball SHA-256 | \`${result.tarballSha256}\` |`,
    `| manifest.json SHA-256 | \`${result.manifestSha256}\` |`,
    `| provenance.json SHA-256 | \`${result.provenanceSha256}\` |`,
    ...IMAGES.map(image => `| ${image} image | \`${result.images[image]}\` |`),
    '',
    'Retained only as a run-specific Actions artifact for 60 days. No npm package, release, tag, image, site or deployment was published.',
    '',
  ].join('\n');
}

const argumentsOf = argv => {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    if (!key?.startsWith('--') || argv[index + 1] === undefined || Object.hasOwn(args, key.slice(2))) {
      throw new Error(`Invalid argument: ${key}`);
    }
    args[key.slice(2)] = argv[index + 1];
  }
  return args;
};

const main = () => {
  const [command, ...argv] = process.argv.slice(2);
  const args = argumentsOf(argv);
  if (command === 'trust') {
    trust({
      eventName: args.event, ref: args.ref, repository: args.repository, trustedMain: args['trusted-main'],
      sourceRevision: args['source-revision'], app: args['app-image'], ui: args['ui-image'], agent: args['agent-image'],
      root: resolve(args.root), output: args.output, githubOutput: args['github-output'],
    });
  } else if (command === 'source-ready') {
    sourceReady({ root: resolve(args.root), sourceRevision: args['source-revision'], trustedMain: args['trusted-main'] });
  } else if (command === 'verify-output') {
    const result = verifyOutput({ root: resolve(args.root), input: args.input, trustedMain: args['trusted-main'] });
    if (!args['github-output'] || !args.summary || existsSync(args.summary)) throw new Error('verify-output requires new output paths');
    writeFileSync(args.summary, operatorSummary(result), { flag: 'wx' });
    appendFileSync(args['github-output'], `version=${result.version}\nartifact_path=${result.artifactPath}\n`);
  } else {
    throw new Error('Expected trust, source-ready, or verify-output command');
  }
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); }
  catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
