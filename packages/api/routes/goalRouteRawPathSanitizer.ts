const RAW_PATH_REDACTION = '[REDACTED_SENSITIVE_PATH]';
const RAW_PATH_TERMINATOR = /[\s"'`<>,;?#&()[\]{}]/u;
const RAW_PATH_OPENER = /[\s"'`=()[\]{:};,&]/u;
const WORD_CHARACTER = /[\p{L}\p{N}]/u;
const URI_SCHEME = /[a-z][a-z0-9+.-]*$/iu;
const WINDOWS_DRIVE = /^\/?[a-z][:|]/iu;
const VALID_PERCENT_OCTET = /%[0-9a-f]{2}/iu;
const CREDENTIAL_SEGMENT = /^(?:\.aws|\.azure|\.config|\.docker|\.env(?:\.(?!example$).*)?|\.git-credentials|\.gnupg|\.kube|\.netrc|\.npmrc|\.ssh|configs?|configuration|credentials?|docker\.sock|secrets?|workspaces?|worktrees?)$/iu;

// Eight standard passes cover every supported encoded form while keeping work
// independent of attacker-controlled nesting. A remaining valid octet makes a
// classified path fail closed instead of driving another pass.
const MAX_PERCENT_DECODE_PASSES = 8;
const MAX_CLASSIFIED_TOKEN_CHARACTERS = 16_640;

const POSIX_SENSITIVE_ROOTS = new Set([
  'app', 'build', 'builds', 'data', 'etc', 'github', 'home', 'mnt', 'opt',
  'private', 'root', 'run', 'srv', 'tmp', 'users', 'var', 'workspace',
  'workspaces', 'worktree', 'worktrees',
]);
const WINDOWS_SENSITIVE_ROOTS = new Set([
  'programdata', 'users', 'windows', 'workspace', 'workspaces', 'worktree', 'worktrees',
]);

interface MappedCharacter {
  character: string;
  rawEnd: number;
  rawStart: number;
}

interface DecodedView {
  characters: MappedCharacter[];
  value: string;
}

interface RawPathCandidate {
  decodedToken: string;
  end: number;
  endIndex: number;
  partial: boolean;
  start: number;
  token: string;
  tooLong: boolean;
}

interface ClassifiedCharacter {
  character: string;
  end: number;
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

function isHexCharacter(character: string | undefined): boolean {
  return character !== undefined && /^[0-9a-f]$/iu.test(character);
}

/** Decode standard percent octets while retaining their exact raw spans. */
function decodeMappedValue(value: string): DecodedView {
  let rawIndex = 0;
  let characters: MappedCharacter[] = [];
  for (const character of value) {
    characters.push({
      character,
      rawEnd: rawIndex + character.length,
      rawStart: rawIndex,
    });
    rawIndex += character.length;
  }
  for (let pass = 0; pass < MAX_PERCENT_DECODE_PASSES; pass += 1) {
    const decoded: MappedCharacter[] = [];
    let changed = false;
    for (let index = 0; index < characters.length; index += 1) {
      const current = characters[index]!;
      const high = characters[index + 1];
      const low = characters[index + 2];
      if (current.character === '%' && isHexCharacter(high?.character)
        && isHexCharacter(low?.character)) {
        decoded.push({
          character: String.fromCharCode(Number.parseInt(
            `${high!.character}${low!.character}`,
            16
          )),
          rawEnd: low!.rawEnd,
          rawStart: current.rawStart,
        });
        index += 2;
        changed = true;
      } else {
        decoded.push(current);
      }
    }
    characters = decoded;
    if (!changed) break;
  }
  return { characters, value: characters.map(({ character }) => character).join('') };
}

/**
 * Read a boundary character through an unresolved contiguous percent nesting.
 * This is classification-only: the candidate will fail closed because a valid
 * percent octet remains after the bounded standard decoder.
 */
function readClassifiedCharacter(value: string, index: number): ClassifiedCharacter | undefined {
  if (value[index] !== '%') return value[index] === undefined
    ? undefined
    : { character: value[index]!, end: index + 1 };
  let octetIndex = index + 1;
  while (value.slice(octetIndex, octetIndex + 2).toLowerCase() === '25') octetIndex += 2;
  const octet = value.slice(octetIndex, octetIndex + 2);
  if (!/^[0-9a-f]{2}$/iu.test(octet)) return undefined;
  return {
    character: String.fromCharCode(Number.parseInt(octet, 16)),
    end: octetIndex + 2,
  };
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

function hasRawPathBoundary(value: string, index: number): boolean {
  if (index === 0) return true;
  const previous = value[index - 1]!;
  if (previous === '|') return index === 1 || !WORD_CHARACTER.test(value[index - 2]!);
  return RAW_PATH_OPENER.test(previous);
}

function followsUriScheme(value: string, index: number): boolean {
  if (index === 0 || value[index - 1] !== ':') return false;
  let schemeStart = index - 1;
  while (schemeStart > 0 && /[a-z0-9+.-]/iu.test(value[schemeStart - 1]!)) schemeStart -= 1;
  return URI_SCHEME.test(value.slice(schemeStart, index - 1));
}

function canStartRawPath(value: string, index: number): boolean {
  if (!hasRawPathBoundary(value, index) || followsUriScheme(value, index)) return false;
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
  decoded: DecodedView,
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
  const start = decoded.characters[startIndex]!.rawStart;
  const end = endIndex === decoded.characters.length
    ? original.length
    : decoded.characters[endIndex]!.rawStart;
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
    // Traversal into credential-bearing shares is private; homogeneous safe
    // authorities otherwise retain the established public behavior.
    return residualOctet || (normalized.traversal && normalized.credential);
  }
  if (candidate.partial || candidate.tooLong || residualOctet) return true;
  if (normalized.credential) return true;
  const root = normalized.root;
  if (normalized.pipeDrive && !normalized.traversal) return false;
  return root !== undefined && (normalized.windowsRoot
    ? WINDOWS_SENSITIVE_ROOTS.has(root)
    : POSIX_SENSITIVE_ROOTS.has(root));
}

/** Redact complete raw path tokens after bounded, mapped percent decoding. */
export function redactRawPathTokens(value: string, inputTruncated: boolean): string {
  const decoded = decodeMappedValue(value);
  let result = '';
  let copiedThrough = 0;
  for (let index = 0; index < decoded.value.length; index += 1) {
    if (!canStartRawPath(decoded.value, index)) continue;
    const candidate = readRawPathCandidate(decoded, value, index, inputTruncated);
    if (shouldRedactRawPath(candidate)) {
      result += `${value.slice(copiedThrough, candidate.start)}${RAW_PATH_REDACTION}`;
      copiedThrough = candidate.end;
    }
    index = Math.max(index, candidate.endIndex - 1);
  }
  return copiedThrough === 0 ? value : `${result}${value.slice(copiedThrough)}`;
}
