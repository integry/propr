// Prepare-only source and runtime binding. No registry write or npm publication.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inspectRuntimeReference, sha256File, validateIdentity } from '../../../scripts/preview-runtime-images.mjs';

const SHA = /^[0-9a-f]{40}$/;
const keys = (value, expected, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== [...expected].sort().join(',')) {
    throw new Error(`${label} has unexpected fields`);
  }
};

export function validatePreviewInput(input) {
  keys(input, ['schemaVersion', 'repository', 'sourceRevision', 'images'], 'Preview input');
  if (input.schemaVersion !== 1 || input.repository !== 'integry/propr'
    || typeof input.sourceRevision !== 'string' || input.sourceRevision.length !== 40 || !SHA.test(input.sourceRevision)) {
    throw new Error('Preview input requires integry/propr and a full lowercase source SHA');
  }
  keys(input.images, ['app', 'ui', 'agent'], 'Preview image scope');
  for (const image of ['app', 'ui', 'agent']) {
    const pattern = new RegExp(`^propr/${image}:${input.sourceRevision}@sha256:[0-9a-f]{64}$`);
    if (typeof input.images[image] !== 'string' || input.images[image].trim() !== input.images[image] || !pattern.test(input.images[image])) {
      throw new Error(`Preview ${image} must be an exact source-tagged, digest-pinned propr/${image} reference`);
    }
  }
  return input;
}

export function verifyPreviewInput(input, registry) {
  validatePreviewInput(input);
  const verified = {};
  for (const image of ['app', 'ui', 'agent']) {
    const architectures = image === 'agent' ? ['amd64'] : ['amd64', 'arm64'];
    const inspection = inspectRuntimeReference(input.images[image], image, input.sourceRevision, architectures, registry);
    if (inspection.reference !== input.images[image]) throw new Error(`Preview ${image} digest mismatch`);
    verified[image] = { reference: inspection.reference, platforms: architectures.map(arch => `linux/${arch}`) };
  }
  return verified;
}

export function validatePreviewSource(input, trustedMain, root, env = process.env) {
  validatePreviewInput(input);
  if (typeof trustedMain !== 'string' || trustedMain.length !== 40 || !SHA.test(trustedMain)) throw new Error('--trusted-main requires a full lowercase SHA');
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const origin = git(['remote', 'get-url', 'origin']);
  if (!['https://github.com/integry/propr.git', 'https://github.com/integry/propr', 'git@github.com:integry/propr.git'].includes(origin)) {
    throw new Error('origin must be the canonical integry/propr repository');
  }
  if (git(['rev-parse', 'refs/remotes/origin/main']) !== trustedMain) throw new Error('Trusted revision must match the fetched origin/main');
  if (env.GITHUB_ACTIONS === 'true' && (env.GITHUB_REPOSITORY !== 'integry/propr'
    || env.GITHUB_REF !== 'refs/heads/main' || env.GITHUB_SHA !== trustedMain
    || env.GITHUB_EVENT_NAME !== 'workflow_dispatch')) {
    throw new Error('CI preparation requires workflow_dispatch from integry/propr main at the trusted revision');
  }
  validateIdentity({ sourceRevision: input.sourceRevision, workflowRevision: trustedMain,
    dispatchRef: 'refs/heads/main', operation: 'prepare-agent' }, root);
  if (git(['status', '--porcelain', '--untracked-files=all'])) throw new Error('Preview preparation requires a clean source checkout');
}

export function createPreviewPackage(baseVersion, input, verified) {
  validatePreviewInput(input);
  if (!/^\d+\.\d+\.\d+$/.test(baseVersion)) throw new Error('Preview base version must be numeric stable semver');
  // Full SHA plus full binding hash: rebuilding different reviewed runtime
  // digests at the same source cannot reuse the same CLI version.
  const binding = createHash('sha256').update(JSON.stringify(['app', 'ui', 'agent'].map(name => input.images[name]))).digest('hex');
  const version = `${baseVersion}-preview.${input.sourceRevision}.${binding}`;
  return {
    version,
    manifest: {
      version, git_sha: input.sourceRevision, registry: 'propr',
      images: { app: input.images.app, ui: input.images.ui, agent: input.images.agent,
        redis: 'redis:7-alpine', cloudflared: 'cloudflare/cloudflared:2024.12.2' },
      previewRuntime: { schemaVersion: 1, repository: input.repository, sourceRevision: input.sourceRevision,
        fleetPlatform: 'linux/amd64', verified },
    },
  };
}

export function writePreviewEvidence(directory, tarball, preview, trustedMain, smoke) {
  const manifestPath = join(directory, 'manifest.json');
  writeFileSync(manifestPath, `${JSON.stringify(preview.manifest, null, 2)}\n`);
  const hashes = { [tarball]: sha256File(join(directory, tarball)), 'manifest.json': sha256File(manifestPath) };
  const evidence = {
    schemaVersion: 1, repository: 'integry/propr', sourceRevision: preview.manifest.git_sha,
    trustedMain, cliVersion: preview.version, images: preview.manifest.previewRuntime.verified,
    files: hashes, smoke, nodeVersion: process.version,
    npmVersion: execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim(),
    lockfileSha256: sha256File(new URL('../../../package-lock.json', import.meta.url)),
  };
  writeFileSync(join(directory, 'provenance.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  hashes['provenance.json'] = sha256File(join(directory, 'provenance.json'));
  writeFileSync(join(directory, 'SHA256SUMS'), Object.entries(hashes).map(([file, hash]) => `${hash}  ${file}\n`).join(''));
  return evidence;
}

export function readPreviewOptions(argv, root) {
  if (!argv.length || (argv.length === 1 && argv[0] === '--publish')) return undefined;
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!['--preview-input', '--trusted-main'].includes(key) || args[key] || !argv[i + 1] || argv[i + 1].startsWith('--')) {
      throw new Error('Use --preview-input FILE --trusted-main SHA; preview cannot publish');
    }
    args[key] = argv[i + 1];
  }
  if (!args['--preview-input'] || !args['--trusted-main']) throw new Error('Preview requires --preview-input and --trusted-main');
  const input = JSON.parse(readFileSync(args['--preview-input'], 'utf8'));
  validatePreviewSource(input, args['--trusted-main'], root);
  const verified = verifyPreviewInput(input);
  const baseVersion = JSON.parse(readFileSync(join(root, 'packages/cli/package.json'), 'utf8')).version;
  return { ...createPreviewPackage(baseVersion, input, verified), trustedMain: args['--trusted-main'] };
}
