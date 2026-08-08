export const MIN_SESSION_SECRET_LENGTH = 32;

const KNOWN_PLACEHOLDERS = new Set([
  'your-session-secret-here',
  'your-secret-key-here',
  'your-secret-key-here-change-in-production',
  'generate-a-strong-secret-here',
  'paste_the_generated_hex_string_here',
]);

/** Return a safe operator-facing error when a session secret is unusable. */
export function validateSessionSecret(secret: string | undefined): string | undefined {
  const normalized = secret?.trim();
  if (!normalized) return 'SESSION_SECRET is required';
  if (KNOWN_PLACEHOLDERS.has(normalized.toLowerCase())) {
    return 'SESSION_SECRET still contains an example placeholder';
  }
  if (normalized.length < MIN_SESSION_SECRET_LENGTH) {
    return `SESSION_SECRET must be at least ${MIN_SESSION_SECRET_LENGTH} characters`;
  }
  return undefined;
}
