const RAW_PATH_REDACTION = '[REDACTED_SENSITIVE_PATH]';
const RAW_PATH_TERMINATOR = /[\s"'`<>,;?#&()[\]{}]/u;
const RAW_PATH_OPENER = /[\s"'`=()[\]{:};,&]/u;
const WORD_CHARACTER = /[\p{L}\p{N}]/u;
const URI_SCHEME = /[a-z][a-z0-9+.-]*$/iu;
const WINDOWS_DRIVE = /^\/?[a-z][:|]/iu;
const RESIDUAL_PERCENT_PATH_SYNTAX = /%(?:25)*(?:20|2e|2f|3a|5c|7c)/iu;
const RESIDUAL_PERCENT_OCTET = /%(?:25)*([0-9a-f]{2})/giu;
const CREDENTIAL_SEGMENT = /^(?:\.aws|\.azure|\.config|\.docker|\.env(?:\.(?!example$).*)?|\.git-credentials|\.gnupg|\.kube|\.netrc|\.npmrc|\.ssh|configs?|configuration|credentials?|docker\.sock|secrets?|workspaces?|worktrees?)$/iu;

const POSIX_SENSITIVE_ROOTS = new Set([
  'app', 'build', 'builds', 'data', 'etc', 'github', 'home', 'mnt', 'opt',
  'private', 'root', 'run', 'srv', 'tmp', 'users', 'var', 'workspace',
  'workspaces', 'worktree', 'worktrees',
]);
const WINDOWS_SENSITIVE_ROOTS = new Set([
  'programdata', 'users', 'windows', 'workspace', 'workspaces', 'worktree', 'worktrees',
]);

interface RawPathCandidate {
  end: number;
  partial: boolean;
  token: string;
}

interface ClassifiedCharacter {
  character: string;
  end: number;
}

function decodePercentOctets(value: string): string {
  let decoded = value;
  for (let pass = 0; pass < 2; pass += 1) {
    const next = decoded.replace(/%([0-9a-f]{2})/giu, (_match, octet: string) => (
      String.fromCharCode(Number.parseInt(octet, 16))
    ));
    if (next === decoded) break;
    decoded = next;
  }
  return decoded;
}

function decodeResidualPercentOctets(value: string): string {
  return value.replace(RESIDUAL_PERCENT_OCTET, (_match, octet: string) => (
    String.fromCharCode(Number.parseInt(octet, 16))
  ));
}

function decodeForPathClassification(value: string): string {
  return decodeResidualPercentOctets(decodePercentOctets(value));
}

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

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 0x1f || codePoint === 0x7f) return true;
  }
  return false;
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
  // Exactly two leading separators are URI-authority/UNC syntax. Three or
  // more forward slashes still name a rooted POSIX path after normalization.
  if (separatorCount !== 0 && separatorCount !== 2) return true;
  if (separatorCount !== 0 || classified === undefined || !/[a-z]/iu.test(classified.character)) {
    return false;
  }
  const driveDelimiter = readClassifiedCharacter(value, classified.end)?.character;
  return driveDelimiter === ':' || driveDelimiter === '|';
}

function isDrivePipe(value: string, start: number, pipeIndex: number): boolean {
  return /^\/?[a-z]\|$/iu.test(decodePercentOctets(value.slice(start, pipeIndex + 1)));
}

function windowsDotSegmentSeparatorIndex(
  value: string,
  start: number,
  spaceIndex: number
): number | undefined {
  let separatorIndex = spaceIndex;
  while (value[separatorIndex] === ' ') separatorIndex += 1;
  const suffix = decodeForPathClassification(value.slice(separatorIndex, separatorIndex + 16));
  if (!/^[\\/]/u.test(suffix)) return undefined;
  const initialPrefix = decodeForPathClassification(value.slice(start, start + 24));
  const localPrefix = decodeForPathClassification(
    value.slice(Math.max(start, spaceIndex - 64), spaceIndex)
  );
  const windows = suffix.startsWith('\\') || initialPrefix.startsWith('\\')
    || WINDOWS_DRIVE.test(initialPrefix.replace(/\\/gu, '/')) || localPrefix.includes('\\');
  if (!windows) return undefined;
  const segment = localPrefix.replace(/\\/gu, '/').split('/').at(-1)?.replace(/ +$/u, '');
  return segment === '.' || segment === '..' ? separatorIndex : undefined;
}

function readRawPathCandidate(
  value: string,
  start: number,
  inputTruncated: boolean
): RawPathCandidate {
  let end = start;
  while (end < value.length) {
    const character = value[end]!;
    if (character === ' ') {
      const separatorIndex = windowsDotSegmentSeparatorIndex(value, start, end);
      if (separatorIndex !== undefined) {
        end = separatorIndex;
        continue;
      }
    }
    if (RAW_PATH_TERMINATOR.test(character)
      || (character === '|' && !isDrivePipe(value, start, end))) break;
    end += 1;
  }
  return {
    end,
    partial: inputTruncated && end === value.length,
    token: value.slice(start, end),
  };
}

function normalizedSegments(token: string): {
  drive: boolean;
  invalid: boolean;
  segments: string[];
  traversal: boolean;
  windows: boolean;
  windowsRoot: boolean;
} {
  const percentDecoded = decodePercentOctets(token);
  const windows = percentDecoded.includes('\\')
    || WINDOWS_DRIVE.test(percentDecoded.replace(/\\/gu, '/'));
  const windowsRoot = percentDecoded.startsWith('\\')
    || WINDOWS_DRIVE.test(percentDecoded.replace(/\\/gu, '/'));
  const decoded = percentDecoded.replace(/\\/gu, '/');
  if (hasControlCharacter(decoded)) {
    return {
      drive: false, invalid: true, segments: [], traversal: false, windows, windowsRoot,
    };
  }
  const driveMatch = decoded.match(/^\/?[a-z][:|]/iu);
  const drive = driveMatch !== null;
  const separatorCount = decoded.match(/^\/+/u)?.[0].length ?? 0;
  if (!drive && (!decoded.startsWith('/') || separatorCount === 2)) {
    return { drive, invalid: true, segments: [], traversal: false, windows, windowsRoot };
  }
  const remainder = drive ? decoded.slice(driveMatch[0].length) : decoded;
  const segments: string[] = [];
  let traversal = false;
  for (const rawSegment of remainder.split('/')) {
    if (rawSegment === '' || rawSegment === '.') continue;
    const windowsDotSegment = windows ? rawSegment.replace(/ +$/u, '') : rawSegment;
    if (windowsDotSegment === '.') continue;
    if (windowsDotSegment === '..') {
      traversal = true;
      segments.pop(); // Absolute and drive roots are normalization floors.
      continue;
    }
    const segment = (windows ? rawSegment.replace(/[. ]+$/u, '') : rawSegment).toLowerCase();
    if (segment !== '') segments.push(segment);
  }
  return { drive, invalid: false, segments, traversal, windows, windowsRoot };
}

function shouldRedactRawPath(candidate: RawPathCandidate): boolean {
  if (candidate.partial) return true;
  const decoded = decodePercentOctets(candidate.token);
  // Never accept a path while another percent layer can still materialize a
  // separator, dot, drive delimiter, or Windows-trimmed dot-segment space.
  if (RESIDUAL_PERCENT_PATH_SYNTAX.test(decoded)) return true;
  const normalized = normalizedSegments(candidate.token);
  if (normalized.invalid || !normalized.traversal) return false;
  if (hasMalformedPercentEncoding(candidate.token)) return true;
  if (normalized.segments.some((segment) => CREDENTIAL_SEGMENT.test(segment))) return true;
  const root = normalized.segments[0];
  return root !== undefined && (normalized.windowsRoot
    ? WINDOWS_SENSITIVE_ROOTS.has(root)
    : POSIX_SENSITIVE_ROOTS.has(root));
}

/** Redact complete raw path tokens after bounded percent decoding and dot-segment normalization. */
export function redactRawPathTokens(value: string, inputTruncated: boolean): string {
  let result = '';
  let copiedThrough = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (!canStartRawPath(value, index)) continue;
    const candidate = readRawPathCandidate(value, index, inputTruncated);
    if (shouldRedactRawPath(candidate)) {
      result += `${value.slice(copiedThrough, index)}${RAW_PATH_REDACTION}`;
      copiedThrough = candidate.end;
    }
    index = Math.max(index, candidate.end - 1);
  }
  return copiedThrough === 0 ? value : `${result}${value.slice(copiedThrough)}`;
}
