type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

function hasControlCharacter(value: string): boolean {
  return [...value].some(char => {
    const code = char.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

function isSafeBranchName(value: string): boolean {
  return !/[\s~^:?*[\\]/.test(value) &&
    !hasControlCharacter(value) &&
    !value.startsWith('/') &&
    !value.endsWith('/') &&
    !value.endsWith('.') &&
    !value.includes('..') &&
    !value.includes('//') &&
    !value.includes('@{') &&
    !value.split('/').some(segment => segment.endsWith('.lock'));
}

export function normalizeOptionalBranchName(value: unknown, fieldName: string, repoName: string): ValidationResult<string | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== 'string') return { ok: false, error: `Invalid ${fieldName} format for ${repoName}: must be a string` };
  const trimmed = value.trim();
  if (!trimmed) return { ok: true, value: undefined };
  return isSafeBranchName(trimmed)
    ? { ok: true, value: trimmed }
    : { ok: false, error: `Invalid ${fieldName} format for ${repoName}: contains whitespace or branch characters unsupported by ProPR` };
}
