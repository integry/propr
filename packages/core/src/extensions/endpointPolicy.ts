import { compileEgressAllowlist, normalizeEgressHost } from '../network/egressAllowlist.js';
import type { ExtensionGrantNetwork } from './extensionProfileStore.js';
import dns from 'node:dns/promises';
import https from 'node:https';
import { isIP, BlockList } from 'node:net';
import { EXTENSION_LIMITS } from '@propr/shared';
import { isNonPublicAddress } from '../network/egressProxy.js';

const responseWireBytes = new WeakMap<object, number>();
/** Internal accounting metadata; never serialized with an MCP response. */
export const extensionResponseWireBytes = (value: unknown): number | undefined => value !== null && typeof value === 'object' ? responseWireBytes.get(value) : undefined;
// Match the egress proxy: fake-IP DNS uses 198.18.0.0/15 for public names.
const additional = new BlockList();
for (const [address, prefix] of [['192.0.2.0', 24], ['198.51.100.0', 24], ['203.0.113.0', 24]] as const) additional.addSubnet(address, prefix, 'ipv4');
additional.addSubnet('2001:db8::', 32, 'ipv6');
additional.addSubnet('fec0::', 10, 'ipv6');
additional.addSubnet('2002::', 16, 'ipv6');
additional.addSubnet('2001::', 32, 'ipv6');
additional.addAddress('168.63.129.16', 'ipv4');
export function extensionPublicAddress(address: string): boolean {
  return !isNonPublicAddress(address) && !additional.check(address, isIP(address) === 6 ? 'ipv6' : 'ipv4');
}
export function extensionEndpoint(value: string): URL {
  let url: URL; try { url = new URL(value); } catch { throw new Error('Invalid MCP endpoint'); }
  // Query parameters can be credentials; v1 accepts path-only endpoints.
  if (!value.startsWith('https://') || /[?#]/.test(value) || url.protocol !== 'https:' || url.username || url.password || url.hash || url.search || (url.port && url.port !== '443') || value.length > 2048) throw new Error('MCP endpoints require HTTPS without credentials, query parameters or fragments');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) && !extensionPublicAddress(host)) throw new Error('MCP endpoint must be public');
  if (/^(localhost|.*\.localhost|.*\.local|metadata\.google\.internal)$/i.test(host)) throw new Error('MCP endpoint must be public');
  return url;
}
export type ExtensionLookup = (host: string) => Promise<Array<{ address: string; family: number }>>;
export interface ExtensionEndpointPolicy { network?: ExtensionGrantNetwork; internalAddresses?: string[]; onDecision?: (host: string, allowed: boolean) => Promise<void> }
export async function resolveExtensionEndpoint(value: string, lookup: ExtensionLookup = host => dns.lookup(host, { all: true, verbatim: true }), policy: ExtensionEndpointPolicy = {}): Promise<{ url: URL; address: string; family: number }> {
  const url = policy.internalAddresses ? new URL(value) : extensionEndpoint(value); const host = url.hostname.replace(/^\[|\]$/g, '');
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || (url.port && url.port !== '443')) throw new Error('Invalid MCP endpoint');
  if (policy.network?.mode === 'restricted' && !compileEgressAllowlist(policy.network.allow).allows(host, 443)) {
    await policy.onDecision?.(host, false); throw new Error('MCP endpoint outside run network policy');
  }
  // Node's lookup also accepts IP literals without making a DNS request. Keep
  // the dial address separate from the caller's URL for both names and IPs.
  let timer: NodeJS.Timeout | undefined;
  let addresses: Awaited<ReturnType<ExtensionLookup>>;
  try {
    addresses = await Promise.race([
      lookup(host), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Endpoint DNS timeout')), EXTENSION_LIMITS.timeoutMs); timer.unref(); }),
    ]);
  } finally { clearTimeout(timer); }
  const pinned = policy.internalAddresses?.map(normalizeEgressHost);
  const permitted = addresses.length > 0 && addresses.every(a => {
    if (pinned && !pinned.includes(normalizeEgressHost(a.address))) return false;
    if (!pinned && !extensionPublicAddress(a.address)) return false;
    // Catalog access does not override a restricted run's private-address policy.
    return policy.network?.mode !== 'restricted' || extensionPublicAddress(a.address) || compileEgressAllowlist(policy.network.instanceAllow).allows(a.address, 443);
  });
  await policy.onDecision?.(host, permitted);
  if (!permitted) throw new Error('MCP endpoint must resolve exclusively to public addresses or authorized pinned catalog addresses');
  return { url, ...addresses[0] };
}
/** Resolve on every request, dial only the checked address, keep original TLS
 * identity. No redirect, proxy environment, cookies, content decompression or
 * upstream response headers cross this boundary. */
export async function requestExtensionMcp(endpoint: string, body: unknown, token?: string, policy: ExtensionEndpointPolicy = {}): Promise<unknown> {
  const { url, address, family } = await resolveExtensionEndpoint(endpoint, undefined, policy);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  // Construct the transport destination solely from the vetted address. The
  // original endpoint supplies only the path, HTTP Host and TLS identity.
  const destination = new URL(`https://${family === 6 ? `[${address}]` : address}`);
  destination.pathname = url.pathname;
  const payload = JSON.stringify(body);
  if (Buffer.byteLength(payload) > 64 * 1024) throw new Error('MCP request too large');
  return new Promise((resolve, reject) => {
    const unavailable = () => reject(new Error('MCP connection failed'));
    const request = https.request(destination, {
      method: 'POST', agent: false,
      servername: isIP(host) ? undefined : host,
      lookup: (_host, _options, callback) => callback(null, address, family),
      headers: { Host: url.host, 'Content-Type': 'application/json', Accept: 'application/json', 'MCP-Protocol-Version': '2025-03-26', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    }, response => {
      if (response.statusCode === 202 || response.statusCode === 204) { response.destroy(); resolve(null); return; }
      if (response.statusCode !== 200 || !response.headers['content-type']?.startsWith('application/json')) { response.destroy(); unavailable(); return; }
      const chunks: Buffer[] = []; let bytes = 0;
      response.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > EXTENSION_LIMITS.responseBytes) { response.destroy(); unavailable(); } else chunks.push(chunk); });
      response.on('error', unavailable);
      response.on('end', () => { try { const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (parsed !== null && typeof parsed === 'object') responseWireBytes.set(parsed, bytes); resolve(parsed); } catch { unavailable(); } });
    });
    const timer = setTimeout(() => { request.destroy(); unavailable(); }, EXTENSION_LIMITS.timeoutMs);
    request.on('close', () => clearTimeout(timer)); request.on('error', unavailable); request.end(payload);
  });
}
