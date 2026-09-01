import {
  decodePublicStringView,
  rawSpanForDecodedRange,
  readClassifiedCharacter,
  type DecodedPublicStringView,
  type SensitiveRawSpan,
} from './goalRoutePublicStringDecoder.js';

const RAW_PATH_REDACTION = '[REDACTED_SENSITIVE_PATH]';
const RAW_PATH_TERMINATOR = /[\s"'`<>,;?#&()[\]{}]/u;
const RAW_PATH_OPENER = /[\s"'`=()[\]{:};,?&#]/u;
const WORD_CHARACTER = /[\p{L}\p{N}]/u;
const URI_SCHEME = /[a-z][a-z0-9+.-]*$/iu;
const WINDOWS_DRIVE = /^\/?[a-z][:|]/iu;
const VALID_PERCENT_OCTET = /%[0-9a-f]{2}/iu;
const CREDENTIAL_SEGMENT = /^(?:\.aws|\.azure|\.config|\.docker|\.env(?:\.(?!example$).*)?|\.git-credentials|\.gnupg|\.kube|\.netrc|\.npmrc|\.ssh|configs?|configuration|credentials?|docker\.sock|secrets?|workspaces?|worktrees?)$/iu;

const MAX_CLASSIFIED_TOKEN_CHARACTERS = 16_640;

const POSIX_SENSITIVE_ROOTS = new Set([
  'app', 'build', 'builds', 'data', 'etc', 'github', 'home', 'mnt', 'opt',
  'private', 'root', 'run', 'srv', 'tmp', 'users', 'var', 'workspace',
  'workspaces', 'worktree', 'worktrees',
]);
const WINDOWS_SENSITIVE_ROOTS = new Set([
  'programdata', 'users', 'windows', 'workspace', 'workspaces', 'worktree', 'worktrees',
]);

interface RawPathCandidate {
  decodedToken: string;
  end: number;
  endIndex: number;
  partial: boolean;
  start: number;
  token: string;
  tooLong: boolean;
}

interface NormalizedPath {
  authority: boolean;
  credential: boolean;
  invalid: boolean;
  mixedRoot: boolean;
  pipeDrive: boolean;
  root: string | undefined;
  traversal: boolean;
  windowsRoot: boolean;
}

interface NormalizedSegments {
  credential: boolean;
  root: string | undefined;
  traversal: boolean;
}

function isControlCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0)!;
  return codePoint <= 0x1f || codePoint === 0x7f;
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some(isControlCharacter);
}

function hasMalformedPercentEncoding(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== '%') continue;
    if (!/^[0-9a-f]{2}$/iu.test(value.slice(index + 1, index + 3))) return true;
    index += 2;
  }
  return false;
}

function malformedPercentPrefixBoundaries(value: string): Uint8Array {
  const boundaries = new Uint8Array(value.length + 1);
  let suffix = '';
  let tracking = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (character === '%') {
      tracking = true;
      suffix = '';
    } else if (tracking) {
      if (suffix === '2' && character === '5') suffix = '';
      else if (suffix === '' && character === '2') suffix = '2';
      else suffix = suffix.length < 3 ? `${suffix}${character}` : suffix;
    }
    boundaries[index + 1] = Number(tracking && suffix.length <= 2
      && !/^[0-9a-f]{2}$/iu.test(suffix));
  }
  return boundaries;
}

function hasRawPathBoundary(
  value: string,
  index: number,
  malformedPrefix: boolean
): boolean {
  if (index === 0) return true;
  const previous = value[index - 1]!;
  if (previous === '|') return index === 1 || !WORD_CHARACTER.test(value[index - 2]!);
  return RAW_PATH_OPENER.test(previous) || isControlCharacter(previous)
    || malformedPrefix;
}

function followsUriScheme(value: string, index: number): boolean {
  if (index === 0 || value[index - 1] !== ':') return false;
  let schemeStart = index - 1;
  while (schemeStart > 0 && /[a-z0-9+.-]/iu.test(value[schemeStart - 1]!)) schemeStart -= 1;
  return URI_SCHEME.test(value.slice(schemeStart, index - 1));
}

function canStartRawPath(value: string, index: number, malformedPrefix: boolean): boolean {
  if (!hasRawPathBoundary(value, index, malformedPrefix) || followsUriScheme(value, index)) {
    return false;
  }
  let prefixIndex = index;
  let separatorCount = 0;
  let classified = readClassifiedCharacter(value, prefixIndex);
  while (classified !== undefined && /^[\\/]$/u.test(classified.character)) {
    separatorCount += 1;
    prefixIndex = classified.end;
    classified = readClassifiedCharacter(value, prefixIndex);
  }
  // Homogeneous two-separator authorities still need inspection: safe UNC/URI
  // authorities remain public, but mixed roots and credential traversal do not.
  if (separatorCount !== 0) return true;
  if (classified === undefined || !/[a-z]/iu.test(classified.character)) return false;
  const driveDelimiter = readClassifiedCharacter(value, classified.end)?.character;
  return driveDelimiter === ':' || driveDelimiter === '|';
}

function isDrivePipe(value: string, start: number, pipeIndex: number): boolean {
  return /^\/?[a-z]\|$/iu.test(value.slice(start, pipeIndex + 1));
}

function isCandidateTerminator(character: string): boolean {
  // Controls embedded in a path are invalid candidate content, not boundaries;
  // consuming through them prevents a credential suffix from leaking.
  return !isControlCharacter(character) && RAW_PATH_TERMINATOR.test(character);
}

function readRawPathCandidate(
  decoded: DecodedPublicStringView,
  original: string,
  startIndex: number,
  inputTruncated: boolean
): RawPathCandidate {
  let endIndex = startIndex;
  let segmentStart = startIndex;
  let windows = WINDOWS_DRIVE.test(decoded.value.slice(startIndex, startIndex + 3));
  while (endIndex < decoded.value.length) {
    const character = decoded.value[endIndex]!;
    if (character === '\\') windows = true;
    if (character === ' ') {
      let separatorIndex = endIndex;
      while (decoded.value[separatorIndex] === ' ') separatorIndex += 1;
      const segment = decoded.value.slice(segmentStart, endIndex).replace(/ +$/u, '');
      const separator = decoded.value[separatorIndex];
      if ((windows || separator === '\\') && (segment === '.' || segment === '..')
        && /^[\\/]$/u.test(separator ?? '')) {
        endIndex = separatorIndex;
        continue;
      }
    }
    if (isCandidateTerminator(character)
      || (character === '|' && !isDrivePipe(decoded.value, startIndex, endIndex))) break;
    if (/^[\\/]$/u.test(character)) segmentStart = endIndex + 1;
    endIndex += 1;
  }
  const { end, start } = rawSpanForDecodedRange(
    decoded,
    original.length,
    startIndex,
    endIndex
  );
  return {
    decodedToken: decoded.value.slice(startIndex, endIndex),
    end,
    endIndex,
    partial: inputTruncated && end === original.length,
    start,
    token: original.slice(start, end),
    tooLong: endIndex - startIndex > MAX_CLASSIFIED_TOKEN_CHARACTERS,
  };
}

function normalizeSegment(rawSegment: string, windows: boolean): string {
  return (windows ? rawSegment.replace(/[. ]+$/u, '') : rawSegment).toLowerCase();
}

function normalizePathSegments(remainder: string, windows: boolean): NormalizedSegments {
  const segments: string[] = [];
  let credential = false;
  let traversal = false;
  for (const rawSegment of remainder.split('/')) {
    if (rawSegment === '') continue;
    const windowsDotSegment = windows ? rawSegment.replace(/ +$/u, '') : rawSegment;
    if (windowsDotSegment === '.') continue;
    if (windowsDotSegment === '..') {
      traversal = true;
      segments.pop();
      continue;
    }
    const segment = normalizeSegment(rawSegment, windows);
    if (segment === '') continue;
    if (CREDENTIAL_SEGMENT.test(segment)) credential = true;
    segments.push(segment);
  }
  return { credential, root: segments[0], traversal };
}

function normalizedPath(decoded: string): NormalizedPath {
  const leadingSeparators = decoded.match(/^[\\/]+/u)?.[0] ?? '';
  const driveMatch = decoded.match(/^\/?[a-z][:|]/iu);
  const drive = driveMatch !== null;
  const homogeneousPair = leadingSeparators.length === 2
    && leadingSeparators[0] === leadingSeparators[1];
  const authority = !drive && homogeneousPair;
  const mixedRoot = !drive && leadingSeparators.length === 2 && !homogeneousPair;
  const windows = decoded.includes('\\') || drive || leadingSeparators.startsWith('\\');
  const windowsRoot = decoded.startsWith('\\') || drive;
  const invalidRoot = !drive && leadingSeparators.length === 0;
  const slashNormalized = decoded.replace(/\\/gu, '/');
  const remainder = drive ? slashNormalized.slice(driveMatch![0].length) : slashNormalized;
  const segments = invalidRoot
    ? { credential: false, root: undefined, traversal: false }
    : normalizePathSegments(remainder, windows);
  return {
    authority,
    credential: segments.credential,
    invalid: invalidRoot || hasControlCharacter(decoded),
    mixedRoot,
    pipeDrive: driveMatch?.[0].endsWith('|') ?? false,
    root: segments.root,
    traversal: segments.traversal,
    windowsRoot,
  };
}

function shouldRedactRawPath(candidate: RawPathCandidate): boolean {
  const normalized = normalizedPath(candidate.decodedToken);
  const malformed = hasMalformedPercentEncoding(candidate.token)
    || hasMalformedPercentEncoding(candidate.decodedToken);
  if (normalized.mixedRoot || normalized.invalid || malformed) return true;
  const residualOctet = VALID_PERCENT_OCTET.test(candidate.decodedToken);
  if (normalized.authority) {
    // Exact credential segments are private even without traversal. Homogeneous
    // safe authorities otherwise retain the established public behavior.
    return residualOctet || normalized.credential;
  }
  if (candidate.partial || candidate.tooLong || residualOctet) return true;
  if (normalized.credential) return true;
  const root = normalized.root;
  if (normalized.pipeDrive && !normalized.traversal) return false;
  return root !== undefined && (normalized.windowsRoot
    ? WINDOWS_SENSITIVE_ROOTS.has(root)
    : POSIX_SENSITIVE_ROOTS.has(root));
}

/** Derive ordered raw spans for sensitive paths from the shared decoded view. */
export function findSensitiveRawPathSpans(
  decoded: DecodedPublicStringView,
  value: string,
  inputTruncated: boolean
): SensitiveRawSpan[] {
  const spans: SensitiveRawSpan[] = [];
  const malformedBoundaries = malformedPercentPrefixBoundaries(decoded.value);
  for (let index = 0; index < decoded.value.length; index += 1) {
    if (!canStartRawPath(decoded.value, index, malformedBoundaries[index] === 1)) continue;
    const candidate = readRawPathCandidate(decoded, value, index, inputTruncated);
    if (shouldRedactRawPath(candidate)) spans.push(candidate);
    index = Math.max(index, candidate.endIndex - 1);
  }
  return spans;
}

/** Backward-compatible direct entrypoint; retained public strings use one view. */
export function redactRawPathTokens(value: string, inputTruncated: boolean): string {
  const spans = findSensitiveRawPathSpans(decodePublicStringView(value), value, inputTruncated);
  let result = '';
  let copiedThrough = 0;
  for (const span of spans) {
    result += `${value.slice(copiedThrough, span.start)}${RAW_PATH_REDACTION}`;
    copiedThrough = span.end;
  }
  return copiedThrough === 0 ? value : `${result}${value.slice(copiedThrough)}`;
}
