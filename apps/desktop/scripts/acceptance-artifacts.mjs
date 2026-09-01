import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

export const FIXED_TIME = '2026-01-02T03:04:05.000Z';
export const ACCEPTANCE_ARTIFACT_LEAF = 'desktop-acceptance-artifacts';
export const ACCEPTANCE_PROFILE_PREFIX = 'propr-desktop-acceptance-';
export const ACCEPTANCE_SURFACES_PREFIX = 'propr-acceptance-surfaces-';
export const DESKTOP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const WORKSPACE_ROOT = resolve(DESKTOP_ROOT, '../..');

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

export const FIXED_ACCEPTANCE_ORIGINS = Object.freeze({
  // Canonical loopback aliases keep the fixture private while exercising the
  // renderer's real remote-pairing path instead of its localhost setup lane.
  ready: 'http://127.0.0.2:41731',
  revoked: 'http://127.0.0.3:41732',
  incompatible: 'http://127.0.0.4:41733',
  offline: 'http://127.0.0.1:9',
});

export const DETERMINISTIC_INPUTS = Object.freeze({
  originPolicy: 'fixed-loopback-fixtures',
  origins: Object.values(FIXED_ACCEPTANCE_ORIGINS),
  rendererClock: FIXED_TIME,
  timestamps: FIXED_TIME,
  visibleData: 'fixed-acceptance-fixtures-v1',
  locale: 'en-US',
  timezone: 'UTC',
  font: 'Liberation Sans',
  colorScheme: 'light',
  viewports: 'manifest-per-screenshot',
  scales: 'manifest-per-screenshot',
  zoom: 'manifest-per-screenshot',
  reducedMotion: 'manifest-per-screenshot',
  animations: 'disabled',
  repeatability: 'byte-identical-double-capture',
});

export const defaultAcceptanceOutputDirectory = () => join(WORKSPACE_ROOT, ACCEPTANCE_ARTIFACT_LEAF);
export const screenshotName = (journey, variant) => `${journey}--${variant}.png`;
export const expectedScreenshotNames = () => ACCEPTANCE_JOURNEYS.flatMap(journey =>
  Object.keys(ACCEPTANCE_VARIANTS).map(variant => screenshotName(journey, variant)));

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const canonicalRelative = (root, path) => relative(root, path).split(sep).join('/');
const isSha256 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const isInteger = value => Number.isInteger(value) && value >= 0;

const assertExactKeys = (value, expected, description) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${description} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.join('\n') !== wanted.join('\n')) throw new Error(`${description} schema changed`);
};

const assertExactJson = (actual, expected, description) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${description} changed`);
};

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

const crc32 = bytes => {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
};

const defaultOcr = async bytes => {
  const result = spawnSync('tesseract', ['stdin', 'stdout', '--dpi', '96', '--psm', '11'], {
    input: bytes,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error?.code === 'ENOENT') throw new Error('Acceptance screenshot OCR requires the tesseract executable');
  if (result.error || result.status !== 0) {
    throw new Error(`Acceptance screenshot OCR failed: ${result.error?.message || result.stderr || `status ${result.status}`}`);
  }
  return result.stdout;
};

const renderedImageExtension = description => /\.(?:png|jpe?g|webp)$/i.test(description);

export const scanRenderedScreenshot = async (bytes, description, sentinels = [], ocr = defaultOcr) => {
  const recognized = await ocr(bytes, description);
  if (typeof recognized !== 'string') throw new Error('Acceptance screenshot OCR returned invalid data');
  scanBytes(Buffer.from(recognized), `${description} (rendered pixels)`, sentinels);
};

const readZipEntries = bytes => {
  const minimumEndOffset = Math.max(0, bytes.length - 65_557);
  let endOffset = -1;
  for (let offset = bytes.length - 22; offset >= minimumEndOffset; offset -= 1) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) { endOffset = offset; break; }
  }
  if (endOffset < 0) throw new Error('Acceptance trace ZIP end record is missing');
  const diskNumber = bytes.readUInt16LE(endOffset + 4);
  const centralDisk = bytes.readUInt16LE(endOffset + 6);
  const entriesOnDisk = bytes.readUInt16LE(endOffset + 8);
  const entryCount = bytes.readUInt16LE(endOffset + 10);
  const centralSize = bytes.readUInt32LE(endOffset + 12);
  const centralOffset = bytes.readUInt32LE(endOffset + 16);
  const commentLength = bytes.readUInt16LE(endOffset + 20);
  if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount || entryCount > 10_000
    || centralOffset + centralSize > endOffset || endOffset + 22 + commentLength !== bytes.length) {
    throw new Error('Acceptance trace ZIP directory is invalid or unsupported');
  }
  const entries = [];
  let offset = centralOffset;
  let totalUncompressed = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error('Acceptance trace ZIP entry is invalid');
    const flags = bytes.readUInt16LE(offset + 8);
    const method = bytes.readUInt16LE(offset + 10);
    const checksum = bytes.readUInt32LE(offset + 16);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const uncompressedSize = bytes.readUInt32LE(offset + 24);
    const filenameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const externalAttributes = bytes.readUInt32LE(offset + 38);
    const localOffset = bytes.readUInt32LE(offset + 42);
    const nextOffset = offset + 46 + filenameLength + extraLength + commentLength;
    if (nextOffset > bytes.length || compressedSize === 0xffffffff || uncompressedSize === 0xffffffff
      || (flags & 1) !== 0 || ![0, 8].includes(method) || uncompressedSize > 64 * 1024 * 1024) {
      throw new Error('Acceptance trace ZIP entry uses an unsafe or unsupported encoding');
    }
    const name = bytes.subarray(offset + 46, offset + 46 + filenameLength).toString('utf8');
    if (!name || name.startsWith('/') || name.split('/').includes('..') || ((externalAttributes >>> 16) & 0o170000) === 0o120000) {
      throw new Error('Acceptance trace contains an unsafe entry');
    }
    if (localOffset + 30 > bytes.length || bytes.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('Acceptance trace ZIP local entry is invalid');
    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const localName = bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength).toString('utf8');
    if (localName !== name || bytes.readUInt16LE(localOffset + 6) !== flags
      || bytes.readUInt16LE(localOffset + 8) !== method || dataOffset + compressedSize > bytes.length) {
      throw new Error('Acceptance trace ZIP entry is truncated or inconsistent');
    }
    const compressed = bytes.subarray(dataOffset, dataOffset + compressedSize);
    const value = method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed, { maxOutputLength: 64 * 1024 * 1024 });
    if (value.length !== uncompressedSize || crc32(value) !== checksum) throw new Error('Acceptance trace ZIP entry integrity failed');
    totalUncompressed += value.length;
    if (totalUncompressed > 256 * 1024 * 1024) throw new Error('Acceptance trace ZIP expands beyond its scan limit');
    entries.push({ name, value });
    offset = nextOffset;
  }
  if (offset !== centralOffset + centralSize) throw new Error('Acceptance trace ZIP directory size changed');
  return entries;
};

const scanZip = async (file, sentinels, ocr) => {
  let entries;
  try { entries = readZipEntries(await readFile(file)); } catch (error) {
    throw new Error(`Acceptance trace is not a readable safe ZIP: ${basename(file)}`, { cause: error });
  }
  for (const { name, value } of entries) {
    scanBytes(value, `${file}:${name}`, sentinels);
    if (renderedImageExtension(name)) await scanRenderedScreenshot(value, `${file}:${name}`, sentinels, ocr);
  }
};

export const scanAcceptancePaths = async (paths, sentinels = [], { ocr = defaultOcr } = {}) => {
  for (const input of paths) {
    let stats;
    try { stats = await lstat(input); } catch (error) { if (error?.code === 'ENOENT') continue; throw error; }
    if (stats.isSymbolicLink()) throw new Error(`Acceptance scan input is a symbolic link: ${input}`);
    const files = stats.isDirectory() ? await walkFiles(input) : [input];
    for (const file of files) {
      const bytes = await readFile(file);
      scanBytes(bytes, file, sentinels);
      if (renderedImageExtension(file)) await scanRenderedScreenshot(bytes, file, sentinels, ocr);
      if (file.endsWith('.zip')) await scanZip(file, sentinels, ocr);
    }
  }
};

const allowedCleanup = (kind, allowedWorkspaceParents) => {
  if (kind === 'artifact') {
    return {
      parents: new Set((allowedWorkspaceParents ?? [WORKSPACE_ROOT, DESKTOP_ROOT, tmpdir()]).map(path => resolve(path))),
      name: value => value === ACCEPTANCE_ARTIFACT_LEAF,
    };
  }
  if (kind === 'profile') {
    return { parents: new Set([resolve(tmpdir())]), name: value => new RegExp(`^${ACCEPTANCE_PROFILE_PREFIX}[A-Za-z0-9]+$`).test(value) };
  }
  if (kind === 'surfaces') {
    return { parents: new Set([resolve(tmpdir())]), name: value => new RegExp(`^${ACCEPTANCE_SURFACES_PREFIX}[A-Za-z0-9]+$`).test(value) };
  }
  throw new Error('Unknown acceptance cleanup kind');
};

export const safeRemoveAcceptanceLeaf = async (input, { kind = 'artifact', allowedWorkspaceParents } = {}) => {
  if (!isAbsolute(input)) throw new Error('Acceptance cleanup requires an absolute path');
  const target = resolve(input);
  const policy = allowedCleanup(kind, allowedWorkspaceParents);
  const parent = dirname(target);
  if (target === parse(target).root || !policy.name(basename(target))) {
    throw new Error('Acceptance cleanup target is not a dedicated allowlisted leaf');
  }
  const canonicalAllowedParents = new Set();
  for (const allowedParent of policy.parents) {
    const allowedStats = await lstat(allowedParent);
    if (allowedStats.isSymbolicLink() || !allowedStats.isDirectory()) {
      throw new Error('Acceptance cleanup allowed parent must be an existing non-link directory');
    }
    canonicalAllowedParents.add(await realpath(allowedParent));
  }
  const parentStats = await lstat(parent);
  if (parentStats.isSymbolicLink() || !parentStats.isDirectory()) {
    throw new Error('Acceptance cleanup parent must be an existing non-link directory');
  }
  const canonicalParent = await realpath(parent);
  if (!canonicalAllowedParents.has(canonicalParent)) {
    throw new Error('Acceptance cleanup target parent is not the canonical allowlisted parent');
  }
  let stats;
  try { stats = await lstat(target); } catch (error) { if (error?.code === 'ENOENT') return; throw error; }
  if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error('Acceptance cleanup target must be a non-link directory');
  await rm(target, { recursive: true, force: false });
};

export const prepareAcceptanceArtifactDirectory = async outputDirectory => {
  const root = resolve(outputDirectory);
  await safeRemoveAcceptanceLeaf(root, { kind: 'artifact' });
  await mkdir(join(root, 'screenshots'), { recursive: true, mode: 0o700 });
  return root;
};

const expectedArtifactFiles = () => new Set([
  ...expectedScreenshotNames().map(name => `screenshots/${name}`),
  'accessibility.json',
  'sanitized-summary.json',
  'sanitized-log.json',
  'sanitized-trace.zip',
  'manifest.json',
]);

const validateScreenshotEntry = (entry, expectedName) => {
  assertExactKeys(entry, [
    'name', 'journey', 'variant', 'width', 'height', 'deviceScaleFactor', 'zoom', 'reducedMotion',
    'locale', 'timezone', 'font', 'colorScheme', 'rendererTime', 'originPolicy', 'visibleData',
    'animations', 'bytes', 'sha256', 'repeatabilitySha256',
  ], `Acceptance screenshot ${expectedName}`);
  const [journey, variantWithExtension] = expectedName.split('--');
  const variant = variantWithExtension.slice(0, -4);
  const config = ACCEPTANCE_VARIANTS[variant];
  if (entry.name !== expectedName || entry.journey !== journey || entry.variant !== variant
    || entry.width !== config.viewport.width * config.deviceScaleFactor
    || entry.height !== config.viewport.height * config.deviceScaleFactor
    || entry.deviceScaleFactor !== config.deviceScaleFactor || entry.zoom !== config.zoom
    || entry.reducedMotion !== config.reducedMotion || entry.locale !== DETERMINISTIC_INPUTS.locale
    || entry.timezone !== DETERMINISTIC_INPUTS.timezone || entry.font !== DETERMINISTIC_INPUTS.font
    || entry.colorScheme !== DETERMINISTIC_INPUTS.colorScheme || entry.rendererTime !== FIXED_TIME
    || entry.originPolicy !== DETERMINISTIC_INPUTS.originPolicy || entry.visibleData !== DETERMINISTIC_INPUTS.visibleData
    || entry.animations !== DETERMINISTIC_INPUTS.animations || !isInteger(entry.bytes) || entry.bytes === 0
    || !isSha256(entry.sha256) || entry.repeatabilitySha256 !== entry.sha256) {
    throw new Error(`Acceptance screenshot metadata changed for ${expectedName}`);
  }
};

const validateAccessibility = accessibility => {
  assertExactKeys(accessibility, [
    'schemaVersion', 'generatedAt', 'serious', 'critical', 'findings', 'checks', 'keyboardOrder',
    'visibleFocus', 'modalFocusTrap', 'modalFocusRestore', 'accessibleNames', 'liveAnnouncements',
  ], 'Acceptance accessibility report');
  if (accessibility.schemaVersion !== 2 || accessibility.generatedAt !== FIXED_TIME
    || accessibility.serious !== 0 || accessibility.critical !== 0 || accessibility.findings?.length !== 0
    || accessibility.keyboardOrder !== true || accessibility.visibleFocus !== true
    || accessibility.modalFocusTrap !== true || accessibility.modalFocusRestore !== true
    || accessibility.accessibleNames !== true || accessibility.checks?.length !== expectedScreenshotNames().length) {
    throw new Error('Acceptance accessibility thresholds were not met');
  }
  assertExactKeys(accessibility.liveAnnouncements, ['status', 'error'], 'Acceptance live announcements');
  for (const [kind, evidence] of Object.entries(accessibility.liveAnnouncements)) {
    assertExactKeys(evidence, ['journey', 'beforeHash', 'afterHash', 'mutated'], `Acceptance ${kind} live announcement`);
    if (!ACCEPTANCE_JOURNEYS.includes(evidence.journey) || evidence.mutated !== true
      || !isSha256(evidence.beforeHash) || !isSha256(evidence.afterHash) || evidence.beforeHash === evidence.afterHash) {
      throw new Error(`Acceptance ${kind} live region did not mutate`);
    }
  }
  accessibility.checks.forEach((check, index) => {
    const name = expectedScreenshotNames()[index];
    assertExactKeys(check, [
      'name', 'journey', 'variant', 'serious', 'critical', 'accessibleNames', 'locale', 'timezone',
      'fontLoaded', 'reducedMotion', 'viewport', 'deviceScaleFactor', 'zoom', 'animationsDisabled', 'rendererTime',
    ], `Acceptance accessibility check ${name}`);
    const [journey, variantWithExtension] = name.split('--');
    const variant = variantWithExtension.slice(0, -4);
    const config = ACCEPTANCE_VARIANTS[variant];
    if (check.name !== name || check.journey !== journey || check.variant !== variant
      || JSON.stringify(check.viewport) !== JSON.stringify(config.viewport)
      || check.deviceScaleFactor !== config.deviceScaleFactor || check.zoom !== config.zoom
      || check.reducedMotion !== config.reducedMotion || check.locale !== DETERMINISTIC_INPUTS.locale
      || check.timezone !== DETERMINISTIC_INPUTS.timezone || check.rendererTime !== FIXED_TIME) {
      throw new Error(`Acceptance accessibility metadata changed for ${name}`);
    }
    if (check.serious !== 0 || check.critical !== 0 || check.accessibleNames !== true
      || check.fontLoaded !== true || check.animationsDisabled !== true) {
      throw new Error(`Acceptance accessibility check failed for ${name}`);
    }
  });
};

const validateSummary = summary => {
  assertExactKeys(summary, ['schemaVersion', 'generatedAt', 'status', 'journeys', 'screenshots', 'boundary', 'console', 'services', 'redaction'], 'Acceptance summary');
  if (summary.schemaVersion !== 2 || summary.generatedAt !== FIXED_TIME || summary.status !== 'passed'
    || summary.journeys !== ACCEPTANCE_JOURNEYS.length || summary.screenshots !== expectedScreenshotNames().length
    || summary.redaction !== 'Full raw surfaces were scanned; published logs retain only source, level, byte count, and digest.') {
    throw new Error('Acceptance sanitized summary is invalid');
  }
  assertExactKeys(summary.boundary, ['packagedExecutable', 'rendererOrigin', 'preloadBridge', 'journeys'], 'Acceptance boundary summary');
  if (summary.boundary.packagedExecutable !== true || summary.boundary.rendererOrigin !== 'propr-app://renderer'
    || summary.boundary.preloadBridge !== true
    || summary.boundary.journeys?.join('\n') !== ACCEPTANCE_JOURNEYS.join('\n')) throw new Error('Acceptance executable boundary was not observed');
  assertExactKeys(summary.console, ['records', 'errors'], 'Acceptance console summary');
  if (!isInteger(summary.console.records) || !isInteger(summary.console.errors) || summary.console.errors > summary.console.records) {
    throw new Error('Acceptance console summary is invalid');
  }
  assertExactKeys(summary.services, ['rest', 'socketIo', 'pairing', 'connect'], 'Acceptance service summary');
  const { rest, socketIo, pairing, connect } = summary.services;
  assertExactKeys(rest, ['requestCount', 'authenticatedRequestCount', 'journeys'], 'Acceptance REST summary');
  assertExactKeys(socketIo, ['authenticatedConnections', 'events', 'journeys'], 'Acceptance Socket.IO summary');
  assertExactKeys(pairing, ['started', 'polled', 'activated', 'journeys'], 'Acceptance pairing summary');
  assertExactKeys(connect, ['confirmedRequests', 'journeys'], 'Acceptance Connect summary');
  if (rest.requestCount <= 0 || rest.authenticatedRequestCount <= 0 || !rest.journeys.includes('dashboard-profile-manager')
    || socketIo.authenticatedConnections <= 0 || socketIo.events <= 0 || !socketIo.journeys.includes('dashboard-profile-manager')
    || pairing.started <= 0 || pairing.polled <= 0 || pairing.activated <= 0 || !pairing.journeys.includes('dashboard-profile-manager')
    || connect.confirmedRequests <= 0 || connect.journeys.join('\n') !== 'connect-confirmation') {
    throw new Error('Acceptance claimed service journey was not observed');
  }
};

const validateSanitizedLog = log => {
  assertExactKeys(log, ['schemaVersion', 'generatedAt', 'records'], 'Acceptance sanitized log');
  if (log.schemaVersion !== 1 || log.generatedAt !== FIXED_TIME || !Array.isArray(log.records)) throw new Error('Acceptance sanitized log is invalid');
  for (const record of log.records) {
    assertExactKeys(record, ['journey', 'source', 'level', 'bytes', 'sha256'], 'Acceptance sanitized log record');
    if (!ACCEPTANCE_JOURNEYS.includes(record.journey) || !['renderer-console', 'renderer-page-error', 'packaged-process'].includes(record.source)
      || typeof record.level !== 'string' || !isInteger(record.bytes) || !isSha256(record.sha256)) {
      throw new Error('Acceptance sanitized log record is invalid');
    }
  }
  const processJourneys = log.records.filter(record => record.source === 'packaged-process').map(record => record.journey);
  if (processJourneys.join('\n') !== ACCEPTANCE_JOURNEYS.join('\n')) throw new Error('Acceptance sanitized process log coverage is incomplete');
};

export const validateAcceptanceEvidence = (accessibility, manifest, summary, sanitizedLog) => {
  assertExactKeys(manifest, [
    'schemaVersion', 'generatedAt', 'platform', 'arch', 'executableBoundary', 'deterministicInputs',
    'nativePackageCoverage', 'screenshots', 'supporting',
  ], 'Acceptance manifest');
  if (manifest.schemaVersion !== 2 || manifest.platform !== 'linux' || manifest.arch !== 'x64'
    || manifest.generatedAt !== FIXED_TIME || manifest.executableBoundary !== 'packaged-electron-main-preload-renderer'
    || manifest.screenshots?.length !== expectedScreenshotNames().length) {
    throw new Error('Acceptance manifest is incomplete or non-deterministic');
  }
  assertExactJson(manifest.deterministicInputs, DETERMINISTIC_INPUTS, 'Acceptance deterministic inputs');
  assertExactJson(manifest.nativePackageCoverage, {
    'linux-x64': 'visual-accessibility-runtime',
    'linux-arm64': 'structural-runtime-only',
    'darwin-x64': 'structural-runtime-only',
    'darwin-arm64': 'structural-runtime-only',
    'win32-x64': 'structural-runtime-only',
    'win32-arm64': 'structural-runtime-only',
  }, 'Acceptance native package coverage');
  manifest.screenshots.forEach((entry, index) => validateScreenshotEntry(entry, expectedScreenshotNames()[index]));
  if (!Array.isArray(manifest.supporting) || manifest.supporting.length !== 4) throw new Error('Acceptance supporting manifest is incomplete');
  const expectedSupporting = ['accessibility.json', 'sanitized-summary.json', 'sanitized-log.json', 'sanitized-trace.zip'];
  manifest.supporting.forEach((entry, index) => {
    assertExactKeys(entry, ['name', 'bytes', 'sha256'], `Acceptance supporting artifact ${expectedSupporting[index]}`);
    if (entry.name !== expectedSupporting[index] || !isInteger(entry.bytes) || entry.bytes === 0 || !isSha256(entry.sha256)) {
      throw new Error('Acceptance supporting artifact metadata changed');
    }
  });
  validateAccessibility(accessibility);
  validateSummary(summary);
  validateSanitizedLog(sanitizedLog);
  const rendererLogs = sanitizedLog.records.filter(record => record.source !== 'packaged-process');
  if (rendererLogs.length !== summary.console.records
    || rendererLogs.filter(record => record.level === 'error').length !== summary.console.errors) {
    throw new Error('Acceptance sanitized log and summary counts disagree');
  }
};

export const verifyAcceptanceArtifacts = async (outputDirectory, { sentinels = [], ocr = defaultOcr } = {}) => {
  const root = resolve(outputDirectory);
  const rootStats = await lstat(root);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) throw new Error('Acceptance artifact root must be a non-link directory');
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

  const accessibility = JSON.parse(await readFile(join(root, 'accessibility.json'), 'utf8'));
  const summary = JSON.parse(await readFile(join(root, 'sanitized-summary.json'), 'utf8'));
  const sanitizedLog = JSON.parse(await readFile(join(root, 'sanitized-log.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
  validateAcceptanceEvidence(accessibility, manifest, summary, sanitizedLog);

  for (const entry of manifest.screenshots) {
    const bytes = await readFile(join(root, 'screenshots', entry.name));
    const dimensions = readPngDimensions(bytes);
    if (dimensions.width !== entry.width || dimensions.height !== entry.height
      || bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256) {
      throw new Error(`Acceptance screenshot bytes, digest, or dimensions changed for ${entry.name}`);
    }
  }
  for (const entry of manifest.supporting) {
    const bytes = await readFile(join(root, entry.name));
    if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256) throw new Error(`Acceptance supporting artifact changed for ${entry.name}`);
  }
  await scanAcceptancePaths([root], sentinels, { ocr });
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
    screenshots.push({ ...screenshotMap.get(name), name, bytes: bytes.length, sha256: sha256(bytes) });
  }
  const supporting = [];
  for (const name of ['accessibility.json', 'sanitized-summary.json', 'sanitized-log.json', 'sanitized-trace.zip']) {
    const bytes = await readFile(join(root, name));
    supporting.push({ name, bytes: bytes.length, sha256: sha256(bytes) });
  }
  const manifest = {
    schemaVersion: 2,
    generatedAt: FIXED_TIME,
    platform: 'linux',
    arch: 'x64',
    executableBoundary: 'packaged-electron-main-preload-renderer',
    deterministicInputs: DETERMINISTIC_INPUTS,
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
