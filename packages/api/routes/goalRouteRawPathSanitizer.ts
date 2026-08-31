const RAW_PATH_REDACTION = '[REDACTED_SENSITIVE_PATH]';
const RAW_PATH_TERMINATOR = /[\s"'`<>,;?#&()[\]{}]/u;
const RAW_PATH_OPENER = /[\s"'`=()[\]{:};,&]/u;
const WORD_CHARACTER = /[\p{L}\p{N}]/u;
const URI_SCHEME = /[a-z][a-z0-9+.-]*$/iu;
const WINDOWS_DRIVE = /^\/?[a-z][:|]/iu;
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

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 0x1f || codePoint === 0x7f) return true;
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
  const decodedPrefix = decodePercentOctets(value.slice(index, index + 12));
  if (decodedPrefix.startsWith('/') && !decodedPrefix.startsWith('//')) return true;
  return WINDOWS_DRIVE.test(decodedPrefix);
}

function isDrivePipe(value: string, start: number, pipeIndex: number): boolean {
  return /^\/?[a-z]\|$/iu.test(decodePercentOctets(value.slice(start, pipeIndex + 1)));
}

function readRawPathCandidate(
  value: string,
  start: number,
  inputTruncated: boolean
): RawPathCandidate {
  let end = start;
  while (end < value.length) {
    const character = value[end]!;
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
} {
  const decoded = decodePercentOctets(token).replace(/\\/gu, '/');
  if (hasControlCharacter(decoded)) return { drive: false, invalid: true, segments: [] };
  const driveMatch = decoded.match(/^\/?[a-z][:|]/iu);
  const drive = driveMatch !== null;
  if (!drive && (!decoded.startsWith('/') || decoded.startsWith('//'))) {
    return { drive, invalid: true, segments: [] };
  }
  const remainder = drive ? decoded.slice(driveMatch[0].length) : decoded;
  const segments: string[] = [];
  for (const rawSegment of remainder.split('/')) {
    if (rawSegment === '' || rawSegment === '.') continue;
    if (rawSegment === '..') {
      segments.pop(); // Absolute and drive roots are normalization floors.
      continue;
    }
    const segment = (drive ? rawSegment.replace(/[. ]+$/u, '') : rawSegment).toLowerCase();
    if (segment !== '') segments.push(segment);
  }
  return { drive, invalid: false, segments };
}

function shouldRedactRawPath(candidate: RawPathCandidate): boolean {
  if (candidate.partial) return true;
  const decoded = decodePercentOctets(candidate.token).replace(/\\/gu, '/');
  const traversalPath = decoded.replace(/^\/?[a-z][:|]/iu, '');
  if (!traversalPath.split('/').some((segment) => segment === '.' || segment === '..')) {
    return false;
  }
  const normalized = normalizedSegments(candidate.token);
  if (normalized.invalid) return false;
  if (normalized.segments.some((segment) => CREDENTIAL_SEGMENT.test(segment))) return true;
  const root = normalized.segments[0];
  return root !== undefined && (normalized.drive
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
