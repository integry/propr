#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(here, '..', '..', '..');
const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /@sha256:[0-9a-f]{64}$/;
const COMPATIBILITY = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/;
const REQUIRED_RUNTIME_PLATFORMS = ['linux/amd64', 'linux/arm64'];

const argumentsOf = (argv) => {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith('--') || value === undefined) throw new Error(`Invalid argument ${name ?? ''}`.trim());
    result[name.slice(2)] = value;
  }
  return result;
};

const exactImage = (value, repository, revision, distribution) => {
  if (typeof value !== 'string' || value.length > 512 || /[\0\r\n]/.test(value)) return false;
  if (distribution === 'local') return value === `propr-desktop-local/${repository}:${revision}`;
  return value.startsWith(`propr/${repository}:${revision}@sha256:`) && DIGEST.test(value);
};

export function validateDesktopRuntimeManifest(value, expected = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Desktop runtime manifest must be an object');
  const runtime = value.desktopRuntime;
  if (!runtime || typeof runtime !== 'object' || Array.isArray(runtime)
    || runtime.schemaVersion !== 1
    || !['local', 'published'].includes(runtime.distribution)
    || typeof runtime.sourceRevision !== 'string' || !SHA.test(runtime.sourceRevision)
    || typeof runtime.apiCompatibility !== 'string' || !COMPATIBILITY.test(runtime.apiCompatibility)
    || runtime.desktopAuthenticationProtocol !== 2) {
    throw new Error('Desktop runtime manifest has invalid alignment metadata');
  }
  if (!value.images || typeof value.images !== 'object' || Array.isArray(value.images)
    || !exactImage(value.images.app, 'app', runtime.sourceRevision, runtime.distribution)
    || !exactImage(value.images.ui, 'ui', runtime.sourceRevision, runtime.distribution)) {
    throw new Error('Desktop runtime app and UI images are not bound to the aligned source revision');
  }
  if (value.git_sha !== runtime.sourceRevision) throw new Error('Desktop runtime manifest source revisions disagree');
  if (expected.sourceRevision && runtime.sourceRevision !== expected.sourceRevision) {
    throw new Error('Desktop runtime manifest does not match the desktop release revision');
  }
  if (expected.apiCompatibility && runtime.apiCompatibility !== expected.apiCompatibility) {
    throw new Error('Desktop runtime manifest does not match the desktop API compatibility contract');
  }
  if (expected.distribution && runtime.distribution !== expected.distribution) {
    throw new Error(`Desktop runtime manifest must use ${expected.distribution} images`);
  }
  return value;
}

export function createDesktopRuntimeManifest(base, options) {
  const manifest = {
    ...base,
    git_sha: options.sourceRevision,
    images: { ...base.images, app: options.appImage, ui: options.uiImage },
    desktopRuntime: {
      schemaVersion: 1,
      distribution: options.distribution,
      sourceRevision: options.sourceRevision,
      apiCompatibility: options.apiCompatibility,
      desktopAuthenticationProtocol: 2,
    },
  };
  return validateDesktopRuntimeManifest(manifest, options);
}

export function readDesktopRuntimeManifest(path, expected = {}) {
  return validateDesktopRuntimeManifest(JSON.parse(readFileSync(path, 'utf8')), expected);
}

export function validatePublishedDesktopRuntimeImageInspection(image, repository, sourceRevision, inspection) {
  if (!exactImage(image, repository, sourceRevision, 'published')) {
    throw new Error(`Published desktop runtime ${repository} image is not bound to the release revision`);
  }
  if (!inspection || typeof inspection !== 'object' || Array.isArray(inspection)) {
    throw new Error(`Registry returned invalid manifest metadata for propr/${repository}:${sourceRevision}`);
  }
  const tag = `propr/${repository}:${sourceRevision}`;
  const configuredDigest = image.slice(image.lastIndexOf('@') + 1);
  if (inspection.digest !== configuredDigest) {
    throw new Error(`Published desktop runtime tag ${tag} does not resolve to configured digest ${configuredDigest}`);
  }
  const platforms = new Set((Array.isArray(inspection.manifests) ? inspection.manifests : [])
    .map(manifest => manifest?.platform)
    .filter(platform => platform && typeof platform === 'object')
    .map(platform => `${platform.os}/${platform.architecture}`));
  const missing = REQUIRED_RUNTIME_PLATFORMS.filter(platform => !platforms.has(platform));
  if (missing.length) {
    throw new Error(`Published desktop runtime tag ${tag} is missing required platforms: ${missing.join(', ')}`);
  }
  return inspection;
}

export const DESKTOP_RUNTIME_MANIFEST_MODE = 0o644;

export function normalizeDesktopRuntimeManifestMode(path) {
  chmodSync(path, DESKTOP_RUNTIME_MANIFEST_MODE);
}

export function writeDesktopRuntimeManifest(path, manifest) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, { mode: DESKTOP_RUNTIME_MANIFEST_MODE });
  // writeFileSync's mode applies only when creating a file. Normalize an
  // existing release output too so a prior private mode cannot leak into a
  // root-owned DEB/RPM installation and block the ordinary desktop user.
  normalizeDesktopRuntimeManifestMode(path);
}

const buildLocal = (args) => {
  const checkoutRevision = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repositoryRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'],
  }).trim();
  const sourceRevision = args['source-revision'] ?? checkoutRevision;
  if (!SHA.test(sourceRevision)) throw new Error('A full lowercase Git source revision is required');
  if (sourceRevision !== checkoutRevision) throw new Error('The local runtime revision must match the checked-out commit');
  const dirty = execFileSync('git', ['status', '--porcelain'], {
    cwd: repositoryRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'],
  }).trim();
  if (dirty) throw new Error('Commit the source checkout before building a reproducible desktop runtime');
  const appImage = `propr-desktop-local/app:${sourceRevision}`;
  const uiImage = `propr-desktop-local/ui:${sourceRevision}`;
  execFileSync('docker', ['build', '-f', 'docker/Dockerfile.app.prod', '-t', appImage, '.'], {
    cwd: repositoryRoot, stdio: 'inherit',
  });
  execFileSync('docker', ['build', '-f', 'propr-ui/Dockerfile', '-t', uiImage, '.'], {
    cwd: repositoryRoot, stdio: 'inherit',
  });
  const base = JSON.parse(readFileSync(resolve(repositoryRoot, 'docker/launcher/manifest.json'), 'utf8'));
  const output = resolve(args.output ?? resolve(repositoryRoot, '.propr', 'desktop-runtime', sourceRevision, 'manifest.json'));
  writeDesktopRuntimeManifest(output, createDesktopRuntimeManifest(base, {
    distribution: 'local', sourceRevision, appImage, uiImage,
    apiCompatibility: args['api-compatibility'],
  }));
  process.stdout.write(`${output}\n`);
};

const createRelease = (args) => {
  const sourceRevision = args['source-revision'];
  const output = args.output;
  if (!sourceRevision || !output || !args['app-image'] || !args['ui-image']) {
    throw new Error('Release generation requires source-revision, app-image, ui-image, and output');
  }
  const base = JSON.parse(readFileSync(resolve(args.base ?? resolve(repositoryRoot, 'docker/launcher/manifest.json')), 'utf8'));
  writeDesktopRuntimeManifest(resolve(output), createDesktopRuntimeManifest(base, {
    distribution: 'published', sourceRevision,
    appImage: args['app-image'], uiImage: args['ui-image'],
    apiCompatibility: args['api-compatibility'],
  }));
};

const verifyRelease = (args) => {
  const sourceRevision = args['source-revision'];
  if (!sourceRevision || !args['app-image'] || !args['ui-image']) {
    throw new Error('Release verification requires source-revision, app-image, and ui-image');
  }
  if (!SHA.test(sourceRevision)) throw new Error('A full lowercase Git source revision is required');
  for (const [repository, image] of [['app', args['app-image']], ['ui', args['ui-image']]]) {
    if (!exactImage(image, repository, sourceRevision, 'published')) {
      throw new Error(`Published desktop runtime ${repository} image is not bound to the release revision`);
    }
    const tag = `propr/${repository}:${sourceRevision}`;
    let output;
    try {
      output = execFileSync('docker', [
        'buildx', 'imagetools', 'inspect', tag, '--format', '{{json .Manifest}}',
      ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
    } catch {
      throw new Error(`Published desktop runtime tag ${tag} is unavailable`);
    }
    let inspection;
    try { inspection = JSON.parse(output); }
    catch { throw new Error(`Registry returned invalid manifest metadata for ${tag}`); }
    validatePublishedDesktopRuntimeImageInspection(image, repository, sourceRevision, inspection);
  }
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, ...argv] = process.argv.slice(2);
    const args = argumentsOf(argv);
    if (command === 'local' || command === 'release') {
      if (!args['api-compatibility']) throw new Error('--api-compatibility is required');
      if (command === 'local') buildLocal(args);
      else createRelease(args);
    } else if (command === 'verify-release') verifyRelease(args);
    else throw new Error('Usage: desktop-runtime-manifest.mjs <local|release|verify-release> [options]');
  } catch (error) {
    console.error((error instanceof Error ? error : new Error(String(error))).message);
    process.exitCode = 1;
  }
}
