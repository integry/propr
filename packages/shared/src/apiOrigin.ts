export interface NormalizeProprApiOriginOptions {
  /** Browser-hosted development may deliberately opt into non-loopback HTTP. */
  allowInsecureHttp?: boolean;
  /** The browser client uses an empty value to mean same-origin. */
  allowEmpty?: boolean;
}

/** One documented parity table consumed by client, Electron, store and UI tests. */
export const PROPR_API_ORIGIN_PARITY_CASES = [
  ['https origin', 'https://propr.example.test', 'https://propr.example.test'],
  ['https trailing slash', 'https://propr.example.test/', 'https://propr.example.test'],
  ['localhost', 'http://localhost:3000', 'http://localhost:3000'],
  ['localhost subdomain', 'http://api.dev.localhost:3000', 'http://api.dev.localhost:3000'],
  ['IPv4 127/8', 'http://127.42.7.9:3000', 'http://127.42.7.9:3000'],
  ['IPv6 loopback', 'http://[::1]:3000', 'http://[::1]:3000'],
  ['credentials', 'https://user:secret@propr.example.test', null],
  ['path', 'https://propr.example.test/api', null],
  ['query', 'https://propr.example.test?token=x', null],
  ['fragment', 'https://propr.example.test#x', null],
  ['encoded host', 'http://local%68ost:3000', null],
  ['trailing dot', 'http://localhost.:3000', null],
  ['short IPv4', 'http://127.1:3000', null],
  ['octal IPv4', 'http://0177.0.0.1:3000', null],
  ['hex IPv4', 'http://0x7f000001:3000', null],
  ['mapped IPv6', 'http://[::ffff:127.0.0.1]:3000', null],
  ['mapped IPv6 over HTTPS', 'https://[::ffff:127.0.0.1]:3000', null],
  ['alternate IPv6 spelling', 'https://[0:0:0:0:0:0:0:1]:3000', null],
  ['localhost lookalike', 'http://localhost.example.test:3000', null],
  ['non-loopback HTTP', 'http://192.168.1.20:3000', null],
] as const;

const DECIMAL_IPV4 = /^(0|[1-9][0-9]{0,2})(?:\.(0|[1-9][0-9]{0,2})){3}$/;

const rawHostname = (authority: string): string | null => {
  if (!authority || authority.includes('@') || authority.includes('%') || authority.includes('\\')) return null;
  if (authority.startsWith('[')) {
    const close = authority.indexOf(']');
    if (close < 0 || (authority.slice(close + 1) !== '' && !/^:[0-9]+$/.test(authority.slice(close + 1)))) {
      return null;
    }
    return authority.slice(0, close + 1);
  }
  if ((authority.match(/:/g) ?? []).length > 1) return null;
  return authority.split(':', 1)[0] ?? null;
};

/** True only for the deliberately supported, canonical HTTP loopback names. */
export const isProprLoopbackHostname = (hostname: string): boolean => {
  const normalized = hostname.toLowerCase();
  if (normalized === 'localhost' || normalized === '[::1]') return true;
  if (normalized.endsWith('.localhost')) {
    return normalized.slice(0, -'.localhost'.length).split('.').every(label =>
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)
    );
  }
  if (!DECIMAL_IPV4.test(normalized)) return false;
  const octets = normalized.split('.').map(Number);
  return octets[0] === 127 && octets.every(octet => octet <= 255);
};

/**
 * Return one canonical HTTP(S) origin, or null. The lexical authority checks
 * deliberately run before WHATWG URL parsing so numeric and encoded host
 * aliases cannot be canonicalized into a broader credential scope.
 */
export const canonicalProprHttpUrlOrigin = (
  value: string | null | undefined,
  options: NormalizeProprApiOriginOptions = {},
): string | null => {
  const candidate = value?.trim() ?? '';
  if (!candidate) return options.allowEmpty ? '' : null;
  if (candidate.length > 2_048 || candidate.includes('\\')) return null;

  const lexical = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)(?:[/?#]|$)/.exec(candidate);
  if (!lexical) return null;
  const authorityHostname = rawHostname(lexical[2]);
  if (!authorityHostname || authorityHostname.endsWith('.')) return null;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.username || parsed.password) return null;

  const rawLower = authorityHostname.toLowerCase();
  const parsedLower = parsed.hostname.toLowerCase();
  const rawLooksNumeric = /^[0-9]/.test(rawLower) || rawLower.startsWith('0x') || rawLower.startsWith('[');
  if (rawLooksNumeric && parsedLower !== rawLower) return null;
  if (parsedLower.startsWith('[::ffff:')) return null;

  if (parsed.protocol === 'http:'
    && options.allowInsecureHttp !== true
    && !isProprLoopbackHostname(parsed.hostname)) return null;

  // For HTTP, require the exact supported lexical spelling too. This rejects
  // expanded/mapped IPv6 and every WHATWG alternate IPv4 representation.
  if (parsed.protocol === 'http:' && options.allowInsecureHttp !== true) {
    if (rawLower !== parsedLower || !isProprLoopbackHostname(rawLower)) return null;
  }
  return parsed.origin;
};

export const normalizeProprApiOrigin = (
  value: string | null | undefined,
  options: NormalizeProprApiOriginOptions = {},
): string | null => {
  const candidate = value?.trim() ?? '';
  if (!candidate) return options.allowEmpty ? '' : null;
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*\/?$/.test(candidate)) return null;
  return canonicalProprHttpUrlOrigin(candidate, options);
};
