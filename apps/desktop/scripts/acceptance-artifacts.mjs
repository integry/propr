import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, readlink, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { SETUP_ACTIONS, setupPhase } from './packaged-acceptance-setup.mjs';
import { PACKAGED_ACCEPTANCE_TIME } from './packaged-acceptance-clock.mjs';

export const FIXED_TIME = PACKAGED_ACCEPTANCE_TIME;
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

// Narrow is a desktop window, not phone coverage. Browser phone suites stay separate.
export const acceptanceVariantsFor = journey => ({
  ...ACCEPTANCE_VARIANTS,
  ...Object.fromEntries(Object.keys(SETUP_ACTIONS[journey] ?? {}).map(action => [`zoom-200-${action}`, ACCEPTANCE_VARIANTS['zoom-200']])),
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
  zoom: 'authenticated-electron-web-frame-per-screenshot',
  reducedMotion: 'manifest-per-screenshot',
  animations: 'disabled',
  repeatability: 'byte-identical-double-capture',
});

export const defaultAcceptanceOutputDirectory = () => join(WORKSPACE_ROOT, ACCEPTANCE_ARTIFACT_LEAF);
export const screenshotName = (journey, variant) => `${journey}--${variant}.png`;
export const expectedScreenshotNames = () => ACCEPTANCE_JOURNEYS.flatMap(journey =>
  Object.keys(acceptanceVariantsFor(journey)).map(variant => screenshotName(journey, variant)));

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const canonicalRelative = (root, path) => relative(root, path).split(sep).join('/');
const isSha256 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const isInteger = value => Number.isInteger(value) && value >= 0;
const MAX_VIEWPORT_INSET_CSS_PIXELS = 64;

const assertExactKeys = (value, expected, description) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${description} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.join('\n') !== wanted.join('\n')) throw new Error(`${description} schema changed`);
};

const assertExactJson = (actual, expected, description) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${description} changed`);
};

const assertViewportMetricEvidence = (evidence, config, description) => {
  const expectedEffective = {
    width: config.viewport.width / config.zoom,
    height: config.viewport.height / config.zoom,
  };
  const expectedPhysical = {
    width: config.viewport.width * config.deviceScaleFactor,
    height: config.viewport.height * config.deviceScaleFactor,
  };
  assertExactKeys(evidence.requestedViewport, ['width', 'height'], `${description} requested viewport`);
  assertExactKeys(evidence.playwrightViewport, ['width', 'height'], `${description} Playwright viewport`);
  assertExactKeys(evidence.rendererViewport, ['width', 'height'], `${description} renderer viewport`);
  assertExactKeys(evidence.documentClientViewport, ['width', 'height'], `${description} document client viewport`);
  assertExactKeys(evidence.scrollbarInsets, ['width', 'height'], `${description} scrollbar insets`);
  assertExactKeys(evidence.visualViewportInsets, ['width', 'height'], `${description} visual viewport insets`);
  assertExactKeys(evidence.layoutViewport, ['width', 'height'], `${description} layout viewport`);
  assertExactKeys(evidence.cdpVisualViewport, ['width', 'height', 'scale'], `${description} CDP visual viewport`);
  assertExactKeys(evidence.rendererVisualViewport, ['width', 'height', 'scale'], `${description} renderer visual viewport`);
  assertExactKeys(evidence.effectiveVisibleCssSpan, ['width', 'height'], `${description} effective visible CSS span`);
  assertExactKeys(evidence.geometryZoom, ['width', 'height'], `${description} renderer geometry zoom`);
  assertExactKeys(evidence.physicalPngDimensions, ['width', 'height'], `${description} physical PNG dimensions`);
  const scrollbarInsetsAreValid = ['width', 'height'].every(axis => (
    Number.isFinite(evidence.scrollbarInsets[axis])
    && evidence.scrollbarInsets[axis] >= 0
    && evidence.scrollbarInsets[axis] <= MAX_VIEWPORT_INSET_CSS_PIXELS
    && evidence.scrollbarInsets[axis]
      === evidence.rendererViewport[axis] - evidence.documentClientViewport[axis]
  ));
  const visualViewportInsetsAreValid = ['width', 'height'].every(axis => (
    Number.isFinite(evidence.visualViewportInsets[axis])
    && evidence.visualViewportInsets[axis] >= 0
    && evidence.visualViewportInsets[axis] <= MAX_VIEWPORT_INSET_CSS_PIXELS
    && evidence.visualViewportInsets[axis]
      === evidence.rendererViewport[axis] - evidence.rendererVisualViewport[axis]
  ));
  if (JSON.stringify(evidence.requestedViewport) !== JSON.stringify(config.viewport)
    || JSON.stringify(evidence.playwrightViewport) !== JSON.stringify(config.viewport)
    || JSON.stringify(evidence.rendererViewport) !== JSON.stringify(expectedEffective)
    || !scrollbarInsetsAreValid
    || !visualViewportInsetsAreValid
    || JSON.stringify(evidence.layoutViewport) !== JSON.stringify(evidence.documentClientViewport)
    || JSON.stringify(evidence.rendererVisualViewport) !== JSON.stringify(evidence.cdpVisualViewport)
    || evidence.rendererVisualViewport.scale !== 1
    || JSON.stringify(evidence.effectiveVisibleCssSpan) !== JSON.stringify(expectedEffective)
    || evidence.geometryZoom.width !== config.zoom || evidence.geometryZoom.height !== config.zoom
    || evidence.requestedDeviceScaleFactor !== config.deviceScaleFactor
    || evidence.rendererDevicePixelRatio !== config.deviceScaleFactor * config.zoom
    || evidence.requestedZoomFactor !== config.zoom || evidence.appliedZoomFactor !== config.zoom
    || evidence.zoomResetFactor !== 1 || evidence.zoomMechanism !== 'electron-web-frame'
    || JSON.stringify(evidence.physicalPngDimensions) !== JSON.stringify(expectedPhysical)) {
    throw new Error(`${description} viewport metric evidence changed`);
  }
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

// Token prefixes must start at a token boundary. The desktop profile journal
// stores base64url ciphertext as one printable run, and uniformly random
// base64url bytes spell `gh?_` mid-run by chance; a real token is never
// preceded by another identifier or base64url character. Serialized text
// escapes the whitespace that bounds a token: a JSON log stores a newline or
// tab before a token as `\n`, `\t` or `\u000a`, a URL-encoded one as `%0A`,
// so a prefix right after an escape sequence or a percent-encoded byte is at a
// boundary once decoded. Neither a backslash nor a percent sign is a token or
// base64url character, so this excludes no mid-ciphertext coincidence. The
// scan does not decode text: an escape that decodes to a token character is
// taken for a boundary too, erring toward detection.
const TOKEN_BOUNDARY = String.raw`(?:(?<![A-Za-z0-9_-])|(?<=\\[A-Za-z0-9]|\\u[0-9A-Fa-f]{4}|\\x[0-9A-Fa-f]{2}|%[0-9A-Fa-f]{2}))`;
const genericSecretPatterns = [
  new RegExp(String.raw`${TOKEN_BOUNDARY}propr_it_[A-Za-z0-9_-]{20,}`, 'g'),
  new RegExp(String.raw`${TOKEN_BOUNDARY}gh[pousr]_[A-Za-z0-9_]{20,}`, 'g'),
  /Bearer\s+[A-Za-z0-9._~-]{16,}/gi,
  /(?:token|secret|password|private[_-]?key)\s*[=:]\s*[^\s"']{8,}/gi,
];

// Keep generic matches inside plaintext runs so binary bytes cannot join otherwise separate metadata.
const printableTextRuns = function* (bytes) {
  let start = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index];
    if (byte === 0x09 || byte === 0x0a || byte === 0x0d || (byte >= 0x20 && byte <= 0x7e)) continue;
    if (index > start) yield bytes.subarray(start, index).toString('ascii');
    start = index + 1;
  }
  if (start < bytes.length) yield bytes.subarray(start).toString('ascii');
};

const scanBytes = (bytes, description, sentinels) => {
  for (const sentinel of sentinels) {
    if (sentinel && bytes.includes(Buffer.from(sentinel))) throw new Error(`Secret sentinel found in ${description}`);
  }
  for (const text of printableTextRuns(bytes)) {
    for (const pattern of genericSecretPatterns) {
      pattern.lastIndex = 0;
      if (pattern.test(text)) throw new Error(`Secret-shaped value found in ${description}`);
    }
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

// Short and outside every generic pattern's character classes, so redaction can never mint a new match.
export const ACCEPTANCE_REDACTION_PLACEHOLDER = 'propr-redacted';

const redactSecretText = (text, sentinels) => {
  let redacted = text;
  for (const sentinel of sentinels) {
    if (sentinel) redacted = redacted.split(sentinel).join(ACCEPTANCE_REDACTION_PLACEHOLDER);
  }
  for (const pattern of genericSecretPatterns) {
    pattern.lastIndex = 0;
    redacted = redacted.replace(pattern, ACCEPTANCE_REDACTION_PLACEHOLDER);
  }
  return redacted;
};

const buildZipBytes = entries => {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const { name, value } of entries) {
    const filename = Buffer.from(name, 'utf8');
    const checksum = crc32(value);
    const compressed = deflateRawSync(value, { level: 9 });
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(value.length, 22);
    local.writeUInt16LE(filename.length, 26);
    localParts.push(local, filename, compressed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(value.length, 24);
    central.writeUInt16LE(filename.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, filename);
    offset += 30 + filename.length + compressed.length;
  }
  const centralBytes = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralBytes, end]);
};

// Playwright traces record whatever authenticated requests happen to overlap the tracing
// window, so the published trace must be actively redacted before the sentinel scan runs.
export const sanitizeAcceptanceTrace = async (file, sentinels = []) => {
  const entries = readZipEntries(await readFile(file));
  const sanitized = entries.map(({ name, value }) => ({
    name,
    // latin1 round-trips every byte, so entries without secrets are preserved exactly.
    value: Buffer.from(redactSecretText(value.toString('latin1'), sentinels), 'latin1'),
  }));
  await writeFile(file, buildZipBytes(sanitized), { mode: 0o600 });
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

const validateAcceptanceLeaf = async (input, { kind = 'artifact', allowedWorkspaceParents } = {}) => {
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
  return { target, stats };
};

export const safeRemoveAcceptanceLeaf = async (input, options = {}) => {
  const leaf = await validateAcceptanceLeaf(input, options);
  if (leaf) await rm(leaf.target, { recursive: true, force: false });
};

// Call only after the profile's child has stopped. Verified with Electron 44.7.0
// (Chromium 152.0.7977.130): cookie = uint64, lock = hostname-PID,
// socket = /tmp/scoped_dirXXXXXX/SingletonSocket. Chromium implements these in
// chrome/browser/process_singleton_posix.cc (GenerateCookie/Create).
// Only unlink these exact entries in the private profile; never follow targets.
export const removeOwnedAcceptanceProfileSingletons = async (input, { stoppedChildPid } = {}) => {
  const leaf = await validateAcceptanceLeaf(input, { kind: 'profile' });
  if (!leaf) return;
  const entries = new Map();
  const uid = process.getuid?.();
  // Path lookup alone accepts differently cased aliases on macOS volumes.
  // Only actual directory entries with exact allowlisted spelling qualify.
  const names = new Set(await readdir(leaf.target));
  for (const name of ['SingletonCookie', 'SingletonLock', 'SingletonSocket']) {
    if (!names.has(name)) continue;
    const path = join(leaf.target, name);
    let stats;
    try { stats = await lstat(path); } catch (error) { if (error?.code === 'ENOENT') continue; throw error; }
    if (!stats.isSymbolicLink()) continue; // Regular files still undergo secret scanning.
    if (uid === undefined || leaf.stats.uid !== uid || stats.uid !== uid || (leaf.stats.mode & 0o077) !== 0) {
      throw new Error('Acceptance singleton requires an owned private profile and link');
    }
    entries.set(name, { name, path, stats, target: await readlink(path) });
  }
  const cookie = entries.get('SingletonCookie');
  if (cookie && (!/^(0|[1-9][0-9]{0,19})$/.test(cookie.target) || BigInt(cookie.target) > 18446744073709551615n)) {
    throw new Error('Acceptance singleton cookie target is not a Chromium uint64 token');
  }
  const lock = entries.get('SingletonLock');
  const host = hostname();
  if (lock && (!Number.isSafeInteger(stoppedChildPid) || stoppedChildPid <= 0 ||
      !/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(host) || lock.target !== `${host}-${stoppedChildPid}`)) {
    throw new Error('Acceptance singleton lock target must match the local hostname and stopped child PID');
  }
  const socket = entries.get('SingletonSocket');
  if (socket && (!lock || !cookie || !/^\/tmp\/scoped_dir[A-Za-z0-9]{6}\/SingletonSocket$/.test(socket.target))) {
    throw new Error('Acceptance singleton socket requires the verified Chromium target shape, lock and cookie');
  }
  // Cookie and lock are dangling non-path tokens. Refuse to hide a real file
  // or another link inside the profile. Do not inspect the outside socket target.
  for (const entry of [cookie, lock]) {
    if (!entry) continue;
    try {
      await lstat(join(leaf.target, entry.target));
      throw new Error('Acceptance singleton token target must be absent inside the profile');
    } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }
  const sameEntry = (current, original) => current.dev === original.dev && current.ino === original.ino &&
    current.uid === original.uid && current.mode === original.mode && current.ctimeMs === original.ctimeMs;
  // Validate the complete set before removing anything, including companion
  // links used as socket evidence. Recheck each entry immediately before unlink.
  const check = async entry => {
    const current = await lstat(entry.path);
    const target = await readlink(entry.path);
    const afterRead = await lstat(entry.path);
    const currentProfile = await validateAcceptanceLeaf(input, { kind: 'profile' });
    const currentNames = currentProfile ? await readdir(currentProfile.target) : [];
    if (!currentProfile || currentProfile.stats.dev !== leaf.stats.dev || currentProfile.stats.ino !== leaf.stats.ino ||
        currentProfile.stats.uid !== uid || (currentProfile.stats.mode & 0o077) !== 0 ||
        !currentNames.includes(entry.name) ||
        !sameEntry(current, entry.stats) || !sameEntry(afterRead, entry.stats) || target !== entry.target) {
      throw new Error('Acceptance singleton changed during cleanup');
    }
  };
  for (const entry of entries.values()) await check(entry);
  for (const entry of entries.values()) {
    await check(entry);
    await unlink(entry.path);
  }
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

export const validateSetupEvidence = (evidence, journey, variant) => {
  if (!SETUP_ACTIONS[journey]) {
    if (evidence !== null) throw new Error('Unexpected setup evidence');
    return;
  }
  assertExactKeys(evidence, ['presentation', 'fixture', 'phase', 'capture', 'action'], 'Production setup evidence');
  const actionId = variant.startsWith('zoom-200-') ? variant.slice('zoom-200-'.length) : null;
  if (evidence.presentation !== 'LocalSetupWizard' || evidence.fixture !== 'preload-setup-v1'
    || evidence.phase !== setupPhase(journey) || evidence.capture !== (actionId ? 'keyboard-reached' : 'initial-viewport')) {
    throw new Error('Production setup presentation or fixture state changed');
  }
  if (!actionId) {
    if (evidence.action !== null) throw new Error('Initial viewport cannot claim action reachability');
    return;
  }
  const expected = SETUP_ACTIONS[journey][actionId];
  const action = evidence.action;
  assertExactKeys(action, ['id', 'label', 'tabs', 'focused', 'visible', 'focusVisible', 'activated', 'outcome', 'bridgeCall'], 'Setup action evidence');
  if (!expected || action.id !== actionId || action.label !== expected.label
    || !Number.isInteger(action.tabs) || action.tabs < 1 || action.tabs > 40
    || action.focused !== true || action.visible !== true || action.focusVisible !== true || action.activated !== true
    || action.bridgeCall !== expected.call
    || action.outcome !== (expected.heading ?? (actionId === 'back' ? 'instance-chooser' : 'authentication-required'))) {
    throw new Error('Setup action keyboard activation evidence is incomplete');
  }
};

const validateScreenshotEntry = (entry, expectedName) => {
  assertExactKeys(entry, [
    'name', 'journey', 'variant', 'width', 'height', 'physicalPngDimensions', 'reducedMotion',
    'requestedViewport', 'playwrightViewport', 'rendererViewport', 'documentClientViewport',
    'scrollbarInsets', 'visualViewportInsets', 'layoutViewport',
    'cdpVisualViewport', 'rendererVisualViewport', 'effectiveVisibleCssSpan', 'geometryZoom',
    'requestedDeviceScaleFactor', 'rendererDevicePixelRatio', 'requestedZoomFactor',
    'appliedZoomFactor', 'zoomResetFactor', 'zoomMechanism',
    'locale', 'timezone', 'font', 'colorScheme', 'rendererTime', 'originPolicy', 'visibleData',
    'animations', 'bytes', 'sha256', 'repeatabilitySha256', 'setup',
  ], `Acceptance screenshot ${expectedName}`);
  const [journey, variantWithExtension] = expectedName.split('--');
  const variant = variantWithExtension.slice(0, -4);
  const config = acceptanceVariantsFor(journey)[variant];
  if (entry.name !== expectedName || entry.journey !== journey || entry.variant !== variant
    || entry.width !== config.viewport.width * config.deviceScaleFactor
    || entry.height !== config.viewport.height * config.deviceScaleFactor
    || entry.reducedMotion !== config.reducedMotion || entry.locale !== DETERMINISTIC_INPUTS.locale
    || entry.timezone !== DETERMINISTIC_INPUTS.timezone || entry.font !== DETERMINISTIC_INPUTS.font
    || entry.colorScheme !== DETERMINISTIC_INPUTS.colorScheme || entry.rendererTime !== FIXED_TIME
    || entry.originPolicy !== DETERMINISTIC_INPUTS.originPolicy || entry.visibleData !== DETERMINISTIC_INPUTS.visibleData
    || entry.animations !== DETERMINISTIC_INPUTS.animations || !isInteger(entry.bytes) || entry.bytes === 0
    || !isSha256(entry.sha256) || entry.repeatabilitySha256 !== entry.sha256) {
    throw new Error(`Acceptance screenshot metadata changed for ${expectedName}`);
  }
  validateSetupEvidence(entry.setup, journey, variant);
  assertViewportMetricEvidence(entry, config, `Acceptance screenshot ${expectedName}`);
};

const validateAccessibility = accessibility => {
  assertExactKeys(accessibility, [
    'schemaVersion', 'generatedAt', 'serious', 'critical', 'findings', 'checks', 'keyboardOrder',
    'visibleFocus', 'modalFocusTrap', 'modalFocusRestore', 'accessibleNames', 'liveAnnouncements',
  ], 'Acceptance accessibility report');
  if (accessibility.schemaVersion !== 7 || accessibility.generatedAt !== FIXED_TIME
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
      'fontLoaded', 'reducedMotion', 'animationsDisabled', 'rendererTime', 'physicalPngDimensions',
      'requestedViewport', 'playwrightViewport', 'rendererViewport', 'documentClientViewport',
      'scrollbarInsets', 'visualViewportInsets', 'layoutViewport',
      'cdpVisualViewport', 'rendererVisualViewport', 'effectiveVisibleCssSpan', 'geometryZoom',
      'requestedDeviceScaleFactor', 'rendererDevicePixelRatio', 'requestedZoomFactor',
      'appliedZoomFactor', 'zoomResetFactor', 'zoomMechanism',
    ], `Acceptance accessibility check ${name}`);
    const [journey, variantWithExtension] = name.split('--');
    const variant = variantWithExtension.slice(0, -4);
    const config = acceptanceVariantsFor(journey)[variant];
    if (check.name !== name || check.journey !== journey || check.variant !== variant
      || check.reducedMotion !== config.reducedMotion || check.locale !== DETERMINISTIC_INPUTS.locale
      || check.timezone !== DETERMINISTIC_INPUTS.timezone || check.rendererTime !== FIXED_TIME) {
      throw new Error(`Acceptance accessibility metadata changed for ${name}`);
    }
    assertViewportMetricEvidence(check, config, `Acceptance accessibility check ${name}`);
    if (check.serious !== 0 || check.critical !== 0 || check.accessibleNames !== true
      || check.fontLoaded !== true || check.animationsDisabled !== true) {
      throw new Error(`Acceptance accessibility check failed for ${name}`);
    }
  });
};

export const CSP_SOCKET_JOURNEYS = Object.freeze([
  'csp-reload-pairing', 'csp-reload-restart', 'csp-reload-saved-selection',
]);

export const INSTALLED_SOCKET_JOURNEYS = Object.freeze(['installed-approved', 'installed-restart']);

const validateSocketSession = (socketIo, journey) => {
  assertExactKeys(socketIo, ['records', 'authenticatedConnections', 'subscriptions', 'events', 'journeys', 'handshake'], 'Acceptance Socket.IO session');
  assertExactKeys(socketIo.handshake, [
    'mainAttempts', 'fixtureAttempts', 'scopeQueryPresent', 'scopeQueryCount',
    'scopeEqualsActivatedBinding', 'activeBindingPresent', 'profileGenerationCurrent',
    'originEqualsActivatedBinding', 'path', 'transport', 'resource',
    'rendererBearerPresent', 'rendererCookiePresent', 'authorizationHeaderPresent',
    'authorizationHeaderExactlyMainInjected', 'rendererObservedApplicationEvent', 'rendererLifecycle',
    'rejectionCategory',
  ], 'Acceptance Socket.IO handshake summary');
  const handshake = socketIo.handshake;
  // Only the dashboard captures ordered renderer lifecycle diagnostics. CSP
  // and installed sessions instead retain null, plus strict handshake and
  // application subscription/event evidence from their actual scenarios.
  const dashboard = journey === 'dashboard-profile-manager';
  if (dashboard) {
    assertExactKeys(handshake.rendererLifecycle, [
      'phase', 'profileActivationPublished', 'socketProviderMounted', 'providerDisabled',
      'disabledByDemoModeLoading', 'disabledByDemoMode',
      'disabledByCurrentUserLoading', 'disabledByCurrentUserAbsent',
      'desktopRuntime', 'connectionScope', 'socketConstructionInvocations', 'socketConstructions',
      'connectInvocations',
    ], 'Acceptance renderer Socket.IO lifecycle summary');
  } else if (handshake.rendererLifecycle !== null) {
    throw new Error('Acceptance claimed service journey was not observed');
  }
  if (socketIo.authenticatedConnections !== 1 || socketIo.events !== 1 || socketIo.subscriptions !== 1 || socketIo.records !== 3
    || socketIo.journeys?.length !== 1 || socketIo.journeys[0] !== journey
    || handshake.mainAttempts !== 1 || handshake.fixtureAttempts !== 1
    || handshake.scopeQueryPresent !== true || handshake.scopeQueryCount !== 1
    || handshake.scopeEqualsActivatedBinding !== true
    || handshake.activeBindingPresent !== true || handshake.profileGenerationCurrent !== true
    || handshake.originEqualsActivatedBinding !== true
    || handshake.path !== 'socket-io' || handshake.transport !== 'websocket' || handshake.resource !== 'websocket'
    || handshake.rendererBearerPresent !== false || handshake.rendererCookiePresent !== false
    || handshake.authorizationHeaderPresent !== true || handshake.authorizationHeaderExactlyMainInjected !== true
    || handshake.rendererObservedApplicationEvent !== true
    || (dashboard && (
      handshake.rendererLifecycle.phase !== 'socket-connect-invoked'
      || handshake.rendererLifecycle.profileActivationPublished !== true
      || handshake.rendererLifecycle.socketProviderMounted !== true
      || handshake.rendererLifecycle.providerDisabled !== false
      || handshake.rendererLifecycle.disabledByDemoModeLoading !== false
      || handshake.rendererLifecycle.disabledByDemoMode !== false
      || handshake.rendererLifecycle.disabledByCurrentUserLoading !== false
      || handshake.rendererLifecycle.disabledByCurrentUserAbsent !== false
      || handshake.rendererLifecycle.desktopRuntime !== true
      || handshake.rendererLifecycle.connectionScope !== 'available'
      || handshake.rendererLifecycle.socketConstructionInvocations !== 1
      || handshake.rendererLifecycle.socketConstructions !== 1
      || handshake.rendererLifecycle.connectInvocations !== 1))
    || handshake.rejectionCategory !== 'none') {
    throw new Error('Acceptance claimed service journey was not observed');
  }
};

export const validateSocketServiceSummary = (socketIo, mode = 'packaged') => {
  const { cspSessions, installedSessions, mode: summaryMode, unexpectedRecords, ...dashboard } = socketIo;
  assertExactKeys(socketIo, ['records', 'authenticatedConnections', 'subscriptions', 'events', 'journeys', 'handshake', 'cspSessions', 'installedSessions', 'mode', 'unexpectedRecords'], 'Acceptance Socket.IO summary');
  if (!['packaged', 'installed-rpm'].includes(mode) || summaryMode !== mode
    || !Array.isArray(installedSessions)
    || installedSessions.length !== (mode === 'installed-rpm' ? INSTALLED_SOCKET_JOURNEYS.length : 0)) {
    throw new Error('Acceptance socket summary mode or installed sessions disagree');
  }
  installedSessions.forEach((session, index) => validateSocketSession(session, INSTALLED_SOCKET_JOURNEYS[index]));
  validateSocketSession(dashboard, 'dashboard-profile-manager');
  if (unexpectedRecords !== 0 || !Array.isArray(cspSessions)
    || cspSessions.length !== CSP_SOCKET_JOURNEYS.length) {
    throw new Error('Acceptance claimed service journey was not observed');
  }
  cspSessions.forEach((session, index) => validateSocketSession(session, CSP_SOCKET_JOURNEYS[index]));
};

const validateSummary = (summary, mode) => {
  assertExactKeys(summary, ['schemaVersion', 'generatedAt', 'status', 'journeys', 'screenshots', 'boundary', 'console', 'services', 'redaction'], 'Acceptance summary');
  if (summary.schemaVersion !== 7 || summary.generatedAt !== FIXED_TIME || summary.status !== 'passed'
    || summary.journeys !== ACCEPTANCE_JOURNEYS.length || summary.screenshots !== expectedScreenshotNames().length
    || summary.redaction !== 'Full raw surfaces were scanned; published logs retain only source, level, byte count, and digest.') {
    throw new Error('Acceptance sanitized summary is invalid');
  }
  assertExactKeys(summary.boundary, ['packagedExecutable', 'rendererOrigin', 'preloadBridge', 'journeys'], 'Acceptance boundary summary');
  if (summary.boundary.packagedExecutable !== true || summary.boundary.rendererOrigin !== 'propr-app://renderer'
    || summary.boundary.preloadBridge !== true
    || summary.boundary.journeys?.join('\n') !== ACCEPTANCE_JOURNEYS.join('\n')) throw new Error('Acceptance executable boundary was not observed');
  assertExactKeys(summary.console, [
    'records', 'errors', 'expectedErrors', 'unexpectedErrors', 'errorCategoryCounts',
  ], 'Acceptance console summary');
  const errorCategories = [
    'expectedCspPolicyTransition', 'expectedRevokedAuthorizationResponse', 'currentUserSync', 'apiLoad', 'socketContext',
    'reactRuntime', 'networkResource', 'other', 'pageError',
  ];
  assertExactKeys(summary.console.errorCategoryCounts, errorCategories, 'Acceptance console error categories');
  const categoryTotal = errorCategories.reduce((total, category) => {
    const count = summary.console.errorCategoryCounts[category];
    if (!isInteger(count)) throw new Error('Acceptance console error category is invalid');
    return total + count;
  }, 0);
  if (!isInteger(summary.console.records) || !isInteger(summary.console.errors)
    || !isInteger(summary.console.expectedErrors) || !isInteger(summary.console.unexpectedErrors)
    || summary.console.errors > summary.console.records
    || summary.console.expectedErrors + summary.console.unexpectedErrors !== summary.console.errors
    || summary.console.expectedErrors !== summary.console.errorCategoryCounts.expectedRevokedAuthorizationResponse
      + summary.console.errorCategoryCounts.expectedCspPolicyTransition
    || summary.console.errorCategoryCounts.expectedCspPolicyTransition > 6
    || summary.console.unexpectedErrors !== 0 || categoryTotal !== summary.console.errors) {
    throw new Error('Acceptance console summary is invalid');
  }
  assertExactKeys(summary.services, ['rest', 'socketIo', 'pairing', 'connect'], 'Acceptance service summary');
  const { rest, socketIo, pairing, connect } = summary.services;
  assertExactKeys(rest, ['requestCount', 'authenticatedRequestCount', 'journeys', 'currentUserValidation'], 'Acceptance REST summary');
  assertExactKeys(rest.currentUserValidation, [
    'correlation', 'rendererRequestIssued', 'rendererScopeGeneration', 'mainProxyObserved', 'mainActiveScopeGeneration',
    'activeScopeAccepted', 'mainOnlyBearerInjection', 'upstreamRequestArrived', 'responseStatus',
    'responseClassification', 'parsedUserSchemaAccepted', 'rendererActiveScopeAccepted',
    'firstFailedPredicate',
  ], 'Acceptance current-user validation summary');
  validateSocketServiceSummary(socketIo, mode);
  assertExactKeys(pairing, ['started', 'polled', 'activated', 'journeys'], 'Acceptance pairing summary');
  assertExactKeys(connect, ['confirmedRequests', 'journeys'], 'Acceptance Connect summary');
  const currentUserValidation = rest.currentUserValidation;
  if (rest.requestCount <= 0 || rest.authenticatedRequestCount <= 0 || !rest.journeys.includes('dashboard-profile-manager')
    || currentUserValidation.correlation !== 'current-scope-user-validation'
    || currentUserValidation.rendererRequestIssued !== true
    || !isInteger(currentUserValidation.rendererScopeGeneration) || currentUserValidation.rendererScopeGeneration <= 0
    || currentUserValidation.mainProxyObserved !== true
    || !isInteger(currentUserValidation.mainActiveScopeGeneration) || currentUserValidation.mainActiveScopeGeneration < 0
    || currentUserValidation.activeScopeAccepted !== true
    || currentUserValidation.mainOnlyBearerInjection !== true
    || currentUserValidation.upstreamRequestArrived !== true
    || currentUserValidation.responseStatus !== 200
    || currentUserValidation.responseClassification !== 'success'
    || currentUserValidation.parsedUserSchemaAccepted !== true
    || currentUserValidation.rendererActiveScopeAccepted !== true
    || currentUserValidation.firstFailedPredicate !== 'none'
    || pairing.started <= 0 || pairing.polled <= 0 || pairing.activated <= 0 || !pairing.journeys.includes('dashboard-profile-manager')
    || connect.confirmedRequests <= 0 || connect.journeys.join('\n') !== 'connect-confirmation') {
    throw new Error('Acceptance claimed service journey was not observed');
  }
};

const CSP_RELOAD_LOG_JOURNEYS = ['csp-reload-startup', 'csp-reload-pairing', 'csp-reload-restart', 'csp-reload-deselection', 'csp-reload-saved-selection', 'csp-reload-removal'];
const CSP_RELOAD_PROCESS_JOURNEYS = ['csp-reload-pairing', 'csp-reload-removal'];
const INSTALLED_LOG_JOURNEYS = Object.freeze([
  'installed-approved', 'installed-restart', 'installed-logged-out',
  'installed-reject', 'installed-reject-restart',
  'installed-expire', 'installed-expire-restart',
  'installed-wrong-account', 'installed-wrong-account-restart',
]);
// Each installed phase owns a separate process, including every restart.
const SANITIZED_LOG_CONTRACTS = Object.freeze({
  packaged: {
    journeys: [...ACCEPTANCE_JOURNEYS, ...CSP_RELOAD_LOG_JOURNEYS],
    processJourneys: [...ACCEPTANCE_JOURNEYS, ...CSP_RELOAD_PROCESS_JOURNEYS],
  },
  'installed-rpm': {
    journeys: [...ACCEPTANCE_JOURNEYS, ...CSP_RELOAD_LOG_JOURNEYS, ...INSTALLED_LOG_JOURNEYS],
    processJourneys: [...ACCEPTANCE_JOURNEYS, ...CSP_RELOAD_PROCESS_JOURNEYS, ...INSTALLED_LOG_JOURNEYS],
  },
});

const validateSanitizedLog = log => {
  assertExactKeys(log, ['schemaVersion', 'generatedAt', 'mode', 'records'], 'Acceptance sanitized log');
  if (log.schemaVersion !== 2 || log.generatedAt !== FIXED_TIME || !Array.isArray(log.records)
    || typeof log.mode !== 'string' || !Object.hasOwn(SANITIZED_LOG_CONTRACTS, log.mode)) throw new Error('Acceptance sanitized log is invalid');
  const contract = SANITIZED_LOG_CONTRACTS[log.mode];
  for (const record of log.records) {
    assertExactKeys(record, ['journey', 'source', 'level', 'bytes', 'sha256'], 'Acceptance sanitized log record');
    if (!contract.journeys.includes(record.journey) || !['renderer-console', 'renderer-page-error', 'packaged-process'].includes(record.source)
      || typeof record.level !== 'string' || !isInteger(record.bytes) || !isSha256(record.sha256)) {
      throw new Error('Acceptance sanitized log record is invalid');
    }
  }
  const processJourneys = log.records.filter(record => record.source === 'packaged-process').map(record => record.journey);
  if (processJourneys.join('\n') !== contract.processJourneys.join('\n')) throw new Error('Acceptance sanitized process log coverage is incomplete');
};

export const validateAcceptanceEvidence = (accessibility, manifest, summary, sanitizedLog) => {
  assertExactKeys(manifest, [
    'schemaVersion', 'generatedAt', 'platform', 'arch', 'executableBoundary', 'deterministicInputs',
    'nativePackageCoverage', 'screenshots', 'supporting',
  ], 'Acceptance manifest');
  if (manifest.schemaVersion !== 7 || manifest.platform !== 'linux' || manifest.arch !== 'x64'
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
  }, 'Acceptance native package coverage');
  manifest.screenshots.forEach((entry, index) => validateScreenshotEntry(entry, expectedScreenshotNames()[index]));
  for (const journey of ACCEPTANCE_JOURNEYS) {
    const entries = Object.fromEntries(manifest.screenshots
      .filter(entry => entry.journey === journey)
      .map(entry => [entry.variant, entry]));
    if (entries['zoom-200']?.sha256 === entries.standard?.sha256
      || entries['zoom-200']?.sha256 === entries['high-dpi']?.sha256) {
      throw new Error(`Acceptance zoom-200 screenshot is not visually distinct for ${journey}`);
    }
  }
  if (!Array.isArray(manifest.supporting) || manifest.supporting.length !== 4) throw new Error('Acceptance supporting manifest is incomplete');
  const expectedSupporting = ['accessibility.json', 'sanitized-summary.json', 'sanitized-log.json', 'sanitized-trace.zip'];
  manifest.supporting.forEach((entry, index) => {
    assertExactKeys(entry, ['name', 'bytes', 'sha256'], `Acceptance supporting artifact ${expectedSupporting[index]}`);
    if (entry.name !== expectedSupporting[index] || !isInteger(entry.bytes) || entry.bytes === 0 || !isSha256(entry.sha256)) {
      throw new Error('Acceptance supporting artifact metadata changed');
    }
  });
  validateAccessibility(accessibility);
  validateSanitizedLog(sanitizedLog);
  validateSummary(summary, sanitizedLog.mode);
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
    schemaVersion: 7,
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
    },
    screenshots,
    supporting,
  };
  await writeFile(join(root, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return manifest;
};
