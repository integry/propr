/** Default number of replacement attempts after transient provider failures. */
export const DEFAULT_MAX_PROVIDER_REPLACEMENTS = 2;
/** Upper bound accepted for `max_provider_replacements` / `MAX_PROVIDER_REPLACEMENTS`. */
export const MAX_PROVIDER_REPLACEMENTS_LIMIT = 10;

/** A valid provider replacement cap (0 disables), or null. */
export function parseMaxProviderReplacements(value: unknown): number | null {
  const candidate = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value.trim()) : value;
  return typeof candidate === 'number' && Number.isSafeInteger(candidate)
    && candidate >= 0 && candidate <= MAX_PROVIDER_REPLACEMENTS_LIMIT
    ? candidate
    : null;
}
