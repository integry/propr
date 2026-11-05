/**
 * Browser copy of the API's allowlist entry rules (`parseEgressAllowEntry` in
 * packages/core/src/network/egressAllowlist.ts), so an entry the API would
 * reject is caught before it is committed. `test/egressAllowEntryParity.test.ts`
 * holds the two to the same answers.
 */

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
const IPV4_OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]\\d|\\d)';
const IPV4 = new RegExp(`^${IPV4_OCTET}(?:\\.${IPV4_OCTET}){3}$`);
const IPV6_ZONE = /^[0-9a-z\-.:]+$/i;

/** 4, 6 or 0, like Node's `net.isIP`. */
function ipFamily(value: string): 0 | 4 | 6 {
  if (IPV4.test(value)) return 4;
  if (!value.includes(':')) return 0;
  const zoneAt = value.indexOf('%');
  const address = zoneAt < 0 ? value : value.slice(0, zoneAt);
  if (zoneAt >= 0 && !IPV6_ZONE.test(value.slice(zoneAt + 1))) return 0;
  try {
    new URL(`http://[${address}]/`);
    return 6;
  } catch {
    return 0;
  }
}

function normalizeHost(host: string): string {
  let value = host.trim().toLowerCase();
  if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1);
  if (value.endsWith('.')) value = value.slice(0, -1);
  return value;
}

/** Why the API would reject an allowlist entry, or undefined when it accepts it. */
export function egressAllowEntryError(entry: string): string | undefined {
  if (!entry.trim()) return 'must be a nonempty hostname';
  let value = entry.trim().toLowerCase();
  let port: number | undefined;
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(value);
  if (bracketed) {
    value = bracketed[1];
    if (bracketed[2] !== undefined) port = Number(bracketed[2]);
  } else if (ipFamily(value) !== 6) {
    const portMatch = /^(.*):(\d+)$/.exec(value);
    if (portMatch) { value = portMatch[1]; port = Number(portMatch[2]); }
  }
  if (port !== undefined && (!Number.isSafeInteger(port) || port < 1 || port > 65535)) return 'has an invalid port';
  value = normalizeHost(value);
  if (ipFamily(value)) return undefined;
  const host = value.startsWith('*.') ? value.slice(2) : value;
  if (host.includes('*')) return 'may only use a leading "*." wildcard';
  const labels = host.split('.');
  if (host.length > 253 || labels.length < 2 || !labels.every(label => LABEL.test(label))) {
    return 'must be a hostname with at least two labels, such as "registry.npmjs.org" or "*.example.com"';
  }
  return undefined;
}
