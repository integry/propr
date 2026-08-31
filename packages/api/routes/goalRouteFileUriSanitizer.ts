import { redactSecrets } from '@propr/core';

const FILE_URI_SCHEME = 'file:';
const FILE_URI_TOKEN_BYTE_LIMIT = 4_096;
const FILE_URI_REDACTION = '[REDACTED_SENSITIVE_PATH]';

const LOCAL_RUNTIME_ROOTS = new Set([
  'app',
  'build',
  'builds',
  'data',
  'etc',
  'github',
  'home',
  'mnt',
  'opt',
  'private',
  'root',
  'run',
  'srv',
  'tmp',
  'users',
  'var',
  'workspace',
  'workspaces',
  'worktree',
  'worktrees',
]);

const CREDENTIAL_PATH_SEGMENT = /^(?:\.aws|\.azure|\.config|\.docker|\.env(?:\..*)?|\.git-credentials|\.gnupg|\.kube|\.netrc|\.npmrc|\.ssh|configs?|configuration|credentials?|docker\.sock|secrets?)$/iu;
const SENSITIVE_URI_METADATA = /(?:api[_-]?key|auth(?:orization)?|bearer|credential|password|passwd|private[_-]?key|secret|token|\.aws|\.env|\.netrc|\.ssh)/iu;
const ENCODED_OCTET = /%[0-9a-f]{2}/iu;
const WINDOWS_DRIVE_DESIGNATOR = /^[a-z][:|]$/iu;
const WINDOWS_DRIVE_IN_METADATA = /(?:^|[/?#&=;])[a-z][:|](?=\/)/iu;

interface FileUriCandidate {
  end: number;
  partial: boolean;
  token: string;
}

function hasUriControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 0x1f || codePoint === 0x7f) return true;
  }
  return false;
}

function isFileSchemeAt(value: string, index: number): boolean {
  if (value.slice(index, index + FILE_URI_SCHEME.length).toLowerCase() !== FILE_URI_SCHEME) {
    return false;
  }
  if (index === 0) return true;
  return !/[\p{L}\p{N}+.-]/u.test(value[index - 1]!);
}

function isTokenTerminator(character: string): boolean {
  return /[\s"'`<>]/u.test(character);
}

function readFileUriCandidate(
  value: string,
  start: number,
  inputTruncated: boolean
): FileUriCandidate {
  let end = start + FILE_URI_SCHEME.length;
  while (end < value.length && !isTokenTerminator(value[end]!)) {
    if (end > start + FILE_URI_SCHEME.length && isFileSchemeAt(value, end)) {
      while (end > start && /[,;|]/u.test(value[end - 1]!)) end -= 1;
      break;
    }
    end += 1;
  }
  return {
    end,
    partial: end === value.length && inputTruncated,
    token: value.slice(start, end),
  };
}

function strictlyDecodeUriComponent(value: string): {
  decoded: string;
  encoded: boolean;
  valid: boolean;
} {
  let encoded = false;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== '%') continue;
    encoded = true;
    if (!/^[0-9a-f]{2}$/iu.test(value.slice(index + 1, index + 3))) {
      return { decoded: '', encoded, valid: false };
    }
    index += 2;
  }
  try {
    const decoded = decodeURIComponent(value);
    return {
      decoded,
      encoded,
      valid: !hasUriControlCharacter(decoded) && !ENCODED_OCTET.test(decoded),
    };
  } catch {
    return { decoded: '', encoded, valid: false };
  }
}

function splitLocalFileUri(token: string): {
  metadata: string;
  path: string;
  valid: boolean;
} {
  const rawRemainder = token.slice(FILE_URI_SCHEME.length);
  const normalizedRemainder = rawRemainder.replace(/\\/gu, '/');
  const boundary = normalizedRemainder.search(/[?#]/u);
  const location = boundary < 0 ? normalizedRemainder : normalizedRemainder.slice(0, boundary);
  const metadata = boundary < 0 ? '' : normalizedRemainder.slice(boundary);

  if (location.startsWith('//')) {
    const authorityEnd = location.indexOf('/', 2);
    const authority = authorityEnd < 0 ? location.slice(2) : location.slice(2, authorityEnd);
    const path = authorityEnd < 0 ? '' : location.slice(authorityEnd);
    const localAuthority = authority === '' || authority.toLowerCase() === 'localhost';
    return {
      metadata,
      path,
      valid: localAuthority && !path.startsWith('//'),
    };
  }

  return {
    metadata,
    path: location,
    valid: location.startsWith('/') && !location.startsWith('//'),
  };
}

function normalizeAbsolutePath(path: string): { segments: string[]; valid: boolean } {
  const result: string[] = [];
  for (const segment of path.replace(/\\/gu, '/').split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (result.length === 0) return { segments: [], valid: false };
      result.pop();
      continue;
    }
    if (hasUriControlCharacter(segment)) return { segments: [], valid: false };
    result.push(segment.toLowerCase());
  }
  return { segments: result, valid: true };
}

function hasSensitiveLocalPath(segments: string[]): boolean {
  if (segments.some((segment) => CREDENTIAL_PATH_SEGMENT.test(segment))) return true;
  if (segments.length === 0) return false;
  if (LOCAL_RUNTIME_ROOTS.has(segments[0]!)) return true;
  return WINDOWS_DRIVE_DESIGNATOR.test(segments[0]!);
}

function hasSensitiveMetadata(metadata: string): boolean {
  const normalizedMetadata = metadata.replace(/\\/gu, '/');
  if (WINDOWS_DRIVE_IN_METADATA.test(normalizedMetadata)
    || SENSITIVE_URI_METADATA.test(metadata)
    || redactSecrets(metadata) !== metadata) return true;
  const segments = metadata
    .replace(/\\/gu, '/')
    .split(/[/?#&=;:]+/u)
    .filter(Boolean)
    .map((segment) => segment.toLowerCase());
  if (segments.some((segment) => CREDENTIAL_PATH_SEGMENT.test(segment))) return true;
  return /(?:^|[=&#])\/(?:app|builds?|data|etc|github|home|mnt|opt|private|root|run|srv|tmp|users|var|workspaces?|worktrees?)(?:\/|[?&#;]|$)/iu
    .test(normalizedMetadata);
}

function shouldRedactFileUri(candidate: FileUriCandidate): boolean {
  // A prose label ending in "file:" is not a URI. If it is cut at the
  // inspection boundary, however, it may be the start of a URI and is unsafe.
  if (!candidate.partial && candidate.token.length === FILE_URI_SCHEME.length) return false;
  if (candidate.partial || Buffer.byteLength(candidate.token, 'utf8') > FILE_URI_TOKEN_BYTE_LIMIT) {
    return true;
  }
  if (hasUriControlCharacter(candidate.token)) return true;

  const decoded = strictlyDecodeUriComponent(candidate.token);
  if (!decoded.valid) return true;

  const local = splitLocalFileUri(decoded.decoded);
  if (!local.valid) return true;
  if (hasSensitiveMetadata(local.metadata)) return true;

  const normalized = normalizeAbsolutePath(local.path);
  if (!normalized.valid || normalized.segments.length === 0
    || hasSensitiveLocalPath(normalized.segments)) return true;
  // Encoded file URI spellings remain intentionally fail-closed, but are
  // classified above in decoded/normalized form so encoded drive designators
  // follow the same path and metadata rules as their raw equivalents.
  return decoded.encoded;
}

/**
 * Replace unsafe file URI tokens before a public string is truncated. The
 * caller supplies whether the inspected prefix omitted input, allowing an
 * unterminated token at that boundary to fail closed without scanning an
 * attacker-sized string.
 */
export function redactFileUriTokens(value: string, inputTruncated: boolean): string {
  let result = '';
  let copiedThrough = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (!isFileSchemeAt(value, index)) continue;
    const candidate = readFileUriCandidate(value, index, inputTruncated);
    if (shouldRedactFileUri(candidate)) {
      result += `${value.slice(copiedThrough, index)}${FILE_URI_REDACTION}`;
      copiedThrough = candidate.end;
    }
    index = candidate.end - 1;
  }
  return copiedThrough === 0 ? value : `${result}${value.slice(copiedThrough)}`;
}
