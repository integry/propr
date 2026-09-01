import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

export const ACCEPTANCE_JOURNEYS = Object.freeze([
  'first-run-chooser',
  'manual-endpoint-confirmation',
  'connect-confirmation',
  'remote-pairing',
  'local-setup-prerequisites',
  'local-setup-progress',
  'local-setup-error',
  'local-setup-completion',
  'dashboard-profile-manager',
  'offline',
  'revoked',
  'incompatible-instance',
]);

export const ACCEPTANCE_VARIANTS = Object.freeze({
  standard: { viewport: { width: 1280, height: 820 }, deviceScaleFactor: 1, zoom: 1, reducedMotion: false },
  narrow: { viewport: { width: 880, height: 620 }, deviceScaleFactor: 1, zoom: 1, reducedMotion: false },
  'high-dpi': { viewport: { width: 1280, height: 820 }, deviceScaleFactor: 2, zoom: 1, reducedMotion: false },
  'zoom-200': { viewport: { width: 1280, height: 820 }, deviceScaleFactor: 1, zoom: 2, reducedMotion: false },
  'reduced-motion': { viewport: { width: 1280, height: 820 }, deviceScaleFactor: 1, zoom: 1, reducedMotion: true },
});

export const screenshotName = (journey, variant) => `${journey}--${variant}.png`;
export const expectedScreenshotNames = () => ACCEPTANCE_JOURNEYS.flatMap(journey =>
  Object.keys(ACCEPTANCE_VARIANTS).map(variant => screenshotName(journey, variant)));

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const canonicalRelative = (root, path) => relative(root, path).split(sep).join('/');

export const readPngDimensions = bytes => {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    throw new Error('Acceptance screenshot is not a PNG');
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
};

const walkFiles = async root => {
  const files = [];
  const visit = async directory => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const stats = await lstat(path);
      if (stats.isSymbolicLink()) throw new Error(`Acceptance artifact contains a symbolic link: ${entry.name}`);
      if (stats.isDirectory()) await visit(path);
      else if (stats.isFile()) files.push(path);
      else throw new Error(`Acceptance artifact is not a regular file: ${entry.name}`);
    }
  };
  await visit(root);
  return files.sort();
};

const genericSecretPatterns = [
  /propr_it_[A-Za-z0-9_-]{20,}/g,
  /gh[pousr]_[A-Za-z0-9_]{20,}/g,
  /Bearer\s+[A-Za-z0-9._~-]{16,}/gi,
  /(?:token|secret|password|private[_-]?key)\s*[=:]\s*[^\s"']{8,}/gi,
];

const scanBytes = (bytes, description, sentinels) => {
  const text = bytes.toString('utf8');
  for (const sentinel of sentinels) {
    if (sentinel && bytes.includes(Buffer.from(sentinel))) throw new Error(`Secret sentinel found in ${description}`);
  }
  for (const pattern of genericSecretPatterns) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) throw new Error(`Secret-shaped value found in ${description}`);
  }
};

export const scanAcceptancePaths = async (paths, sentinels = []) => {
  for (const input of paths) {
    let stats;
    try { stats = await lstat(input); } catch (error) { if (error?.code === 'ENOENT') continue; throw error; }
    const files = stats.isDirectory() ? await walkFiles(input) : [input];
    for (const file of files) {
      const bytes = await readFile(file);
      scanBytes(bytes, file, sentinels);
      if (file.endsWith('.zip')) {
        const listing = spawnSync('unzip', ['-Z1', file], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
        if (listing.status !== 0) throw new Error(`Acceptance trace is not a readable ZIP: ${basename(file)}`);
        const entries = listing.stdout.split(/\r?\n/).filter(Boolean);
        if (entries.length > 10_000 || entries.some(entry => entry.startsWith('/') || entry.split('/').includes('..'))) {
          throw new Error('Acceptance trace contains unsafe entries');
        }
        for (const entry of entries) {
          const extracted = spawnSync('unzip', ['-p', file, entry], { maxBuffer: 16 * 1024 * 1024 });
          if (extracted.status !== 0) throw new Error(`Acceptance trace entry could not be read: ${entry}`);
          scanBytes(extracted.stdout, `${file}:${entry}`, sentinels);
        }
      }
    }
  }
};

const expectedArtifactFiles = () => new Set([
  ...expectedScreenshotNames().map(name => `screenshots/${name}`),
  'accessibility.json',
  'sanitized-summary.json',
  'acceptance-trace.zip',
  'manifest.json',
]);

export const validateAcceptanceEvidence = (accessibility, manifest) => {
  if (accessibility.schemaVersion !== 1 || accessibility.serious !== 0 || accessibility.critical !== 0
    || accessibility.keyboardOrder !== true || accessibility.visibleFocus !== true
    || accessibility.modalFocusTrap !== true || accessibility.modalFocusRestore !== true
    || accessibility.accessibleNames !== true || accessibility.liveAnnouncements !== true) {
    throw new Error('Acceptance accessibility thresholds were not met');
  }
  if (manifest.schemaVersion !== 1 || manifest.platform !== 'linux' || manifest.arch !== 'x64'
    || manifest.generatedAt !== '2026-01-02T03:04:05.000Z'
    || manifest.screenshots?.length !== expectedScreenshotNames().length) {
    throw new Error('Acceptance manifest is incomplete or non-deterministic');
  }
  const names = manifest.screenshots.map(entry => entry.name);
  if (new Set(names).size !== names.length || names.join('\n') !== expectedScreenshotNames().join('\n')) {
    throw new Error('Acceptance manifest screenshot order or uniqueness changed');
  }
};

export const verifyAcceptanceArtifacts = async (outputDirectory, { sentinels = [] } = {}) => {
  const root = resolve(outputDirectory);
  const files = await walkFiles(root);
  const relativeFiles = files.map(path => canonicalRelative(root, path));
  const found = new Set(relativeFiles);
  if (found.size !== relativeFiles.length) throw new Error('Duplicate acceptance artifact path');
  const expected = expectedArtifactFiles();
  const missing = [...expected].filter(path => !found.has(path));
  const unexpected = [...found].filter(path => !expected.has(path));
  if (missing.length || unexpected.length) {
    throw new Error(`Acceptance artifact set mismatch (missing: ${missing.join(', ') || 'none'}; unexpected: ${unexpected.join(', ') || 'none'})`);
  }

  for (const journey of ACCEPTANCE_JOURNEYS) {
    for (const [variant, config] of Object.entries(ACCEPTANCE_VARIANTS)) {
      const path = join(root, 'screenshots', screenshotName(journey, variant));
      const dimensions = readPngDimensions(await readFile(path));
      const scale = config.deviceScaleFactor;
      if (dimensions.width !== config.viewport.width * scale || dimensions.height !== config.viewport.height * scale) {
        throw new Error(`Acceptance screenshot dimensions changed for ${screenshotName(journey, variant)}`);
      }
    }
  }

  const accessibility = JSON.parse(await readFile(join(root, 'accessibility.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
  validateAcceptanceEvidence(accessibility, manifest);
  await scanAcceptancePaths([root], sentinels);
  return manifest;
};

export const writeAcceptanceManifest = async (outputDirectory, screenshotMetadata) => {
  const root = resolve(outputDirectory);
  await mkdir(root, { recursive: true });
  const screenshotMap = new Map(screenshotMetadata.map(entry => [entry.name, entry]));
  if (screenshotMap.size !== screenshotMetadata.length) throw new Error('Duplicate acceptance screenshot metadata');
  const expectedNames = new Set(expectedScreenshotNames());
  const unexpectedMetadata = [...screenshotMap.keys()].filter(name => !expectedNames.has(name));
  if (unexpectedMetadata.length) throw new Error(`Unexpected acceptance screenshot metadata: ${unexpectedMetadata.join(', ')}`);
  const screenshots = [];
  for (const name of expectedScreenshotNames()) {
    if (!screenshotMap.has(name)) throw new Error(`Acceptance screenshot metadata is missing ${name}`);
    const path = join(root, 'screenshots', name);
    const bytes = await readFile(path);
    screenshots.push({ ...screenshotMap.get(name), name, sha256: sha256(bytes) });
  }
  const supporting = [];
  for (const name of ['accessibility.json', 'sanitized-summary.json', 'acceptance-trace.zip']) {
    const bytes = await readFile(join(root, name));
    supporting.push({ name, bytes: bytes.length, sha256: sha256(bytes) });
  }
  const manifest = {
    schemaVersion: 1,
    generatedAt: '2026-01-02T03:04:05.000Z',
    platform: 'linux',
    arch: 'x64',
    executableBoundary: 'packaged-electron-main-preload-renderer',
    deterministic: {
      locale: 'en-US', timezone: 'UTC', colorScheme: 'light', font: 'Liberation Sans',
      fixedTime: '2026-01-02T03:04:05.000Z', masking: 'fixed-fixtures-no-dynamic-regions',
    },
    nativePackageCoverage: {
      'linux-x64': 'visual-accessibility-runtime',
      'linux-arm64': 'structural-runtime-only',
      'darwin-x64': 'structural-runtime-only',
      'darwin-arm64': 'structural-runtime-only',
      'win32-x64': 'structural-runtime-only',
      'win32-arm64': 'structural-runtime-only',
    },
    screenshots,
    supporting,
  };
  await writeFile(join(root, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return manifest;
};
