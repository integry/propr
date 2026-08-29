const REDACTED = '[REDACTED]';

const redactString = (value: string): string => value
  .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/gi, REDACTED)
  .replace(/\bBearer\s+[^\s,;"']+/gi, `Bearer ${REDACTED}`)
  .replace(/\bgh[pousr]_[A-Za-z0-9_]{8,}\b/g, REDACTED)
  .replace(/\b((?:authorization|token|secret|password|private[_-]?key|webhook[_-]?secret)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, `$1${REDACTED}`)
  .replace(/\b((?:GH|GITHUB|PROPR|HOST)_[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY)[A-Z0-9_]*\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s]+)/g, `$1${REDACTED}`)
  .replace(/(?:\/[A-Za-z0-9._~ -]+)+\/(?:[^\s"']*?(?:private[-_]?key|github[-_]?app)[^\s"']*|[^\s"']+\.(?:pem|key))\b/gi, REDACTED);

export const redactDesktopText = (value: string, secrets: readonly string[] = []): string => {
  let redacted = value;
  for (const secret of secrets) {
    if (secret.length >= 3) redacted = redacted.split(secret).join(REDACTED);
  }
  return redactString(redacted).slice(0, 8_192);
};

export const redactDesktopValue = (value: unknown, depth = 0, secrets: readonly string[] = []): unknown => {
  if (depth > 12) return '[TRUNCATED]';
  if (typeof value === 'string') return redactDesktopText(value, secrets);
  if (value instanceof Error) {
    return {
      name: redactDesktopText(value.name, secrets),
      message: redactDesktopText(value.message, secrets),
      stack: value.stack ? redactDesktopText(value.stack, secrets) : undefined,
    };
  }
  if (Array.isArray(value)) return value.slice(0, 500).map(item => redactDesktopValue(item, depth + 1, secrets));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 500).map(([key, item]) => [
      key,
      /(?:authorization|token|secret|password|private.?key)/i.test(key) ? REDACTED : redactDesktopValue(item, depth + 1, secrets),
    ]));
  }
  return value;
};

export const safeRendererError = 'Local setup failed unexpectedly. Review the protected desktop log for details.';
