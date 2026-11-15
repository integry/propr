import dns from 'node:dns/promises';
import https from 'node:https';
import { isIP } from 'node:net';
import {
  PLUGIN_HTTP_LIMITS, PluginSdkError,
  type PluginHttpFetch, type PluginHttpRequestInit, type PluginHttpResponse,
} from '@propr/shared';
import { extensionPublicAddress, extensionReservedHostname, type ExtensionLookup } from '../extensions/endpointPolicy.js';

/** One vetted request: the URL as the handler wrote it, the checked address to dial and the final headers. */
export interface PluginHttpTransportRequest {
  url: URL; address: string; family: number;
  method: string; headers: Record<string, string>; body?: Buffer;
  timeoutMs: number; maxResponseBytes: number;
  /** Aborted when the handler run ends; the transport stops sending and receiving then. */
  signal?: AbortSignal;
}
export interface PluginHttpTransportResponse { status: number; headers: Record<string, string>; body: Buffer }
/** Sends one vetted request. Throws `PluginSdkError` (`response_too_large`, `http_failed`). */
export type PluginHttpTransport = (request: PluginHttpTransportRequest) => Promise<PluginHttpTransportResponse>;

export interface PluginHttpOptions {
  /** The manifest's `outboundHosts`: exact hostnames, nothing else is reachable. */
  outboundHosts: readonly string[];
  /** The credential to inject as `Authorization: Bearer`, resolved on the first request; null for none. */
  credential?: () => Promise<string | null>;
  /**
   * Called before every request is sent, after its lookups: throws to refuse
   * it (the installation the credential belongs to was removed or replaced).
   */
  authorize?: () => Promise<void>;
  lookup?: ExtensionLookup;
  transport?: PluginHttpTransport;
  /** Every request decision (`allowed` false when refused), for the handler log. */
  onDecision?: (decision: { host: string; allowed: boolean; reason?: string }) => void;
  /** The handler run's signal: once aborted no request starts, and one in flight is cancelled. */
  signal?: AbortSignal;
}

const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);
/** Headers ProPR sets itself or that would bypass the policy. */
const RESERVED_HEADERS = /^(host|content-length|connection|keep-alive|transfer-encoding|te|trailer|upgrade|proxy-.*|expect)$/i;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/;
const HEADER_VALUE = /^[\t\x20-\x7e\x80-\xff]{0,8192}$/;

const defaultLookup: ExtensionLookup = host => dns.lookup(host, { all: true, verbatim: true });

/**
 * One spelling of a credential. `anyCase`: the spelling reads the same in any
 * letter case (its hex encoding: `Buffer.from(hex, 'hex')` accepts `AB`, `ab`
 * and `aB` alike), so it is matched with ASCII letters folded; every other
 * spelling (the secret itself, its base64) is matched exactly.
 */
export interface CredentialSpelling { text: string; anyCase: boolean }

/** Every spelling of a credential (alone and as the header value sent) a response could echo back. */
function credentialSpellings(secret: string): CredentialSpelling[] {
  const encodings = (value: string): CredentialSpelling[] => {
    // Inside a JSON string: quotes, backslashes and control characters escaped, `/` optionally too.
    const json = JSON.stringify(value).slice(1, -1);
    const exact = [value, json, json.split('/').join('\\/'), Buffer.from(value).toString('base64'), Buffer.from(value).toString('base64url'), encodeURIComponent(value)];
    return [...exact.map(text => ({ text, anyCase: false })), { text: Buffer.from(value).toString('hex'), anyCase: true }];
  };
  return uniqueSpellings([...encodings(`Bearer ${secret}`), ...encodings(secret)]);
}
/** Distinct spellings, longest first: the header value's encodings are not made of the secret's. */
function uniqueSpellings(spellings: readonly CredentialSpelling[]): CredentialSpelling[] {
  const seen = new Map<string, CredentialSpelling>();
  for (const spelling of spellings) if (spelling.text) seen.set(`${spelling.anyCase ? 'i' : 'x'}:${spelling.text}`, spelling);
  return [...seen.values()].sort((a, b) => b.text.length - a.text.length);
}

/** `text` with its ASCII letters lowercased and nothing else changed: the same length, so an index in it is an index in `text`. */
const foldAscii = (text: string) => text.replace(/[A-Z]+/g, run => run.toLowerCase());
/** The haystacks a spelling is searched in: `text` itself, or its ASCII-folded copy for an any-case spelling. */
function haystacks(text: string): (spelling: CredentialSpelling) => string {
  let folded: string | undefined;
  return spelling => (spelling.anyCase ? (folded ??= foldAscii(text)) : text);
}
/** Where `text` holds any spelling: `[start, end)` ranges, overlapping ones included. */
function spellingRanges(text: string, spellings: readonly CredentialSpelling[]): [number, number][] {
  const haystack = haystacks(text);
  const ranges: [number, number][] = [];
  for (const spelling of spellings) {
    const source = haystack(spelling);
    for (let at = source.indexOf(spelling.text); at >= 0; at = source.indexOf(spelling.text, at + 1)) ranges.push([at, at + spelling.text.length]);
  }
  return ranges;
}
/** Whether `text` holds any spelling (an any-case one in any letter case). */
function holdsSpelling(text: string, spellings: readonly CredentialSpelling[]): boolean {
  const haystack = haystacks(text);
  return spellings.some(spelling => haystack(spelling).includes(spelling.text));
}
/** `text` with each range replaced by `[REDACTED]`; overlapping ranges (the header value holds the secret) become one replacement. */
function redactRanges(text: string, ranges: [number, number][]): string {
  if (!ranges.length) return text;
  let scrubbed = ''; let cursor = 0;
  for (const [start, end] of ranges.sort((a, b) => a[0] - b[0])) {
    if (start >= cursor) scrubbed += `${text.slice(cursor, start)}[REDACTED]`;
    cursor = Math.max(cursor, end);
  }
  return scrubbed + text.slice(cursor);
}

/** One percent-escaped ASCII character, its hex digits in either case: `%2f`, `%2F`, `%61`. */
const ASCII_PERCENT_ESCAPE = /%[0-7][0-9a-fA-F]/g;

/**
 * `text` with every spelling replaced also where some of its characters are
 * percent-escaped, whatever the case of the hex digits (`%2f` as well as the
 * `%2F` of `encodeURIComponent`, or an escaped letter): `decodeURIComponent`
 * recovers each of them. Connection secrets are printable ASCII, so only
 * escapes of ASCII characters can spell one. The text is decoded once and each
 * match is mapped back to the characters and escapes it was decoded from.
 */
function scrubPercentEscaped(text: string, spellings: readonly CredentialSpelling[]): string {
  // The decoded position of each escaped character: a decoded index maps back past two more characters per escape before it.
  const escapes: number[] = [];
  const decoded = text.replace(ASCII_PERCENT_ESCAPE, (escape, offset: number) => {
    escapes.push(offset - 2 * escapes.length);
    return String.fromCharCode(parseInt(escape.slice(1), 16));
  });
  if (!escapes.length) return text;
  const original = (index: number) => {
    let low = 0; let high = escapes.length;
    while (low < high) { const middle = (low + high) >> 1; if (escapes[middle] < index) low = middle + 1; else high = middle; }
    return index + 2 * low;
  };
  return redactRanges(text, spellingRanges(decoded, spellings).map(([start, end]) => [original(start), original(end)]));
}
/** `text` with every spelling replaced: as written (an any-case spelling in any letter case), then where percent-escaped. */
const scrub = (text: string, spellings: readonly CredentialSpelling[]) => spellings.length
  ? scrubPercentEscaped(redactRanges(text, spellingRanges(text, spellings)), spellings)
  : text;

const JSON_ESCAPE = /\\(u[0-9a-fA-F]{4}|["\\/bfnrt])/g;
const SHORT_ESCAPES: Record<string, string> = { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
const jsonUnescapeOnce = (value: string) => value.replace(JSON_ESCAPE, (_, escape: string) => escape.length === 5 ? String.fromCharCode(parseInt(escape.slice(1), 16)) : SHORT_ESCAPES[escape] ?? escape);
/**
 * Percent escapes as `decodeURIComponent` and `unescape` decode them, hex
 * digits in either case (`%2f`, `%2F`, `%u002F`). Each byte becomes one
 * character: both agree on the ASCII characters a secret is made of.
 */
const PERCENT_ESCAPE = /%(?:u[0-9a-fA-F]{4}|[0-9a-fA-F]{2})/g;
const percentDecodeOnce = (value: string) => value.replace(PERCENT_ESCAPE, escape => String.fromCharCode(parseInt(escape.slice(escape[1] === 'u' ? 2 : 1), 16)));
/** The decodings a handler can apply to text, in any order and any number of times. */
const DECODINGS = [jsonUnescapeOnce, percentDecodeOnce];
/** Rounds of decoding checked; each nesting level (a JSON document inside a JSON string, a value URL-encoded twice) takes one. */
const UNESCAPE_ROUNDS = 32;
/** Distinct partly decoded texts followed per round (the decodings taken in different orders); more counts as holding a credential. */
const DECODED_VARIANTS = 8;

/**
 * Whether `text` (already scrubbed of literal spellings) holds a credential
 * once its JSON and percent escapes are decoded, once or repeatedly and in any
 * order: `\uXXXX` escapes in HTML or a header, a serialized JSON document
 * inside a JSON string, a value URL-encoded twice or a percent escape inside a
 * JSON string. Text still decoding after the last round could hide one deeper,
 * so counts too. `fold` is applied to each decoded text before comparing
 * (header names compare case-insensitively).
 */
function revealsCredential(text: string, spellings: readonly CredentialSpelling[], fold: (value: string) => string = value => value): boolean {
  let variants = [text];
  for (let round = 0; round < UNESCAPE_ROUNDS; round++) {
    // Every decoding shortens the text, so no variant comes back.
    const next = new Set(variants.flatMap(variant => DECODINGS.map(decode => decode(variant)).filter(decoded => decoded !== variant)));
    if (!next.size) return false;
    if (next.size > DECODED_VARIANTS) return true;
    if ([...next].some(variant => holdsSpelling(fold(variant), spellings))) return true;
    variants = [...next];
  }
  return true;
}

/**
 * Scrub every decoded string (keys included) of a parsed JSON value; `changed`
 * when one held a credential. A string that holds one only once decoded again
 * (serialized JSON inside the string, a value URL-encoded twice) is withheld
 * whole.
 */
function scrubJson(value: unknown, spellings: readonly CredentialSpelling[]): { value: unknown; changed: boolean } {
  let changed = false;
  const clean = (text: string) => {
    const literal = scrub(text, spellings);
    const scrubbed = revealsCredential(literal, spellings) ? '[REDACTED]' : literal;
    if (scrubbed !== text) changed = true;
    return scrubbed;
  };
  const walk = (item: unknown): unknown => {
    if (typeof item === 'string') return clean(item);
    if (Array.isArray(item)) return item.map(walk);
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, entry]) => [clean(key), walk(entry)]));
    return item;
  };
  const scrubbed = walk(value);
  return { value: scrubbed, changed };
}

/**
 * The response text with every credential spelling replaced, also where it is
 * percent-escaped in either case. A JSON body is also checked after decoding
 * (an escaped credential such as `a\"b` decodes to the credential) and
 * re-serialized scrubbed when a decoded string held one. Any body (HTML, text
 * or JSON) that still holds the credential once its JSON and percent escapes
 * are decoded is withheld entirely: a handler could recover it by decoding the
 * escaped part itself.
 */
function scrubbedBody(raw: string, spellings: readonly CredentialSpelling[]): string {
  const text = scrub(raw, spellings);
  if (!spellings.length) return text;
  let body = text;
  let parsed: unknown;
  let json = true;
  try { parsed = JSON.parse(text); } catch { json = false; }
  if (json) {
    try {
      const result = scrubJson(parsed, spellings);
      if (result.changed) body = JSON.stringify(result.value);
    } catch {
      // Too deeply nested to check: refuse rather than return what could decode to the credential.
      throw new PluginSdkError('http_failed', 'The response could not be checked for credentials');
    }
  }
  return revealsCredential(body, spellings) ? '[REDACTED]' : body;
}

/**
 * A response header with every credential spelling replaced, also where it is
 * percent-escaped in either case. A value that still holds one once its JSON
 * and percent escapes are decoded (a JSON-valued header escaping it as
 * `\uXXXX`, also inside a longer, joined or re-encoded value, or a value
 * URL-encoded twice) is withheld entirely: a handler could recover it with
 * `JSON.parse` or `decodeURIComponent`.
 */
function scrubbedHeader(raw: string, spellings: readonly CredentialSpelling[]): string {
  const text = scrub(raw, spellings);
  if (!spellings.length) return text;
  return revealsCredential(text, spellings) ? '[REDACTED]' : text;
}

/**
 * `value` (a log line, its JSON fields, an error message or a JSON result) with
 * the credentials in `secrets` scrubbed from every string and key as a response
 * is: every spelling replaced, also percent-escaped in either case, and a
 * string that still decodes to one withheld whole.
 */
export function scrubCredentialValues<T>(value: T, secrets: readonly string[]): T {
  const spellings = uniqueSpellings(secrets.filter(Boolean).flatMap(credentialSpellings));
  return spellings.length ? scrubJson(value, spellings).value as T : value;
}

const lowerCase = (value: string) => value.toLowerCase();
/**
 * Whether a response header name (lowercased, as the handler sees it) holds a
 * credential. Names are case-insensitive and arrive folded to lowercase (Node
 * folds them), so an echoed credential, its base64 or its `%2F`-style URL
 * encoding, is compared case-insensitively, also once JSON and percent escapes
 * are decoded.
 * A name cannot be scrubbed in place without colliding with others, so a
 * header whose name holds one is dropped.
 */
function nameRevealsCredential(name: string, spellings: readonly CredentialSpelling[]): boolean {
  if (!spellings.length) return false;
  const folded = spellings.map(spelling => ({ ...spelling, text: lowerCase(spelling.text) }));
  return holdsSpelling(name, folded) || revealsCredential(name, folded, lowerCase);
}

/** The error a request gets once the handler run has ended. */
const ended = () => new PluginSdkError('unavailable', 'This handler run has ended');
function checkLive(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw ended();
}
/** Settle with `work`, or reject as soon as the handler run ends. */
function untilEnded<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work;
  checkLive(signal);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(ended());
    signal.addEventListener('abort', abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** Check scheme, credentials in the URL, port and host against the policy. */
function vetUrl(value: unknown, outboundHosts: readonly string[]): URL {
  if (typeof value !== 'string' || value.length > 8192) throw new PluginSdkError('invalid_input', 'The URL must be text of at most 8192 characters');
  let url: URL;
  try { url = new URL(value); } catch { throw new PluginSdkError('invalid_input', 'Invalid URL'); }
  if (url.protocol !== 'https:') throw new PluginSdkError('insecure_url', `Only https:// URLs are allowed, not ${url.protocol}`);
  if (url.username || url.password) throw new PluginSdkError('invalid_input', 'URLs must not carry credentials');
  if (url.port && url.port !== '443') throw new PluginSdkError('host_not_allowed', 'Only the default HTTPS port is allowed');
  const host = url.hostname.toLowerCase();
  if (isIP(host.replace(/^\[|\]$/g, '')) || !outboundHosts.includes(host)) throw new PluginSdkError('host_not_allowed', `${host} is not one of the plugin's outbound hosts`);
  if (extensionReservedHostname(host)) throw new PluginSdkError('private_address', `${host} is a local name`);
  return url;
}

/** Resolve and require every address to be public, like extension endpoints. */
async function resolvePublic(host: string, lookup: ExtensionLookup): Promise<{ address: string; family: number }> {
  let timer: NodeJS.Timeout | undefined;
  let addresses: Awaited<ReturnType<ExtensionLookup>>;
  try {
    addresses = await Promise.race([
      lookup(host),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new PluginSdkError('http_failed', `DNS lookup of ${host} timed out`)), PLUGIN_HTTP_LIMITS.timeoutMs); timer.unref(); }),
    ]);
  } catch (error) {
    throw error instanceof PluginSdkError ? error : new PluginSdkError('http_failed', `${host} could not be resolved`);
  } finally { clearTimeout(timer); }
  if (!addresses.length || !addresses.every(a => extensionPublicAddress(a.address))) throw new PluginSdkError('private_address', `${host} must resolve exclusively to public addresses`);
  return addresses[0];
}

function requestHeaders(init: PluginHttpRequestInit): Record<string, string> {
  const supplied = init.headers ?? {};
  if (typeof supplied !== 'object' || Array.isArray(supplied) || Object.keys(supplied).length > PLUGIN_HTTP_LIMITS.headers) throw new PluginSdkError('invalid_input', `headers must be an object of at most ${PLUGIN_HTTP_LIMITS.headers} entries`);
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(supplied)) {
    if (!HEADER_NAME.test(name) || typeof value !== 'string' || !HEADER_VALUE.test(value)) throw new PluginSdkError('invalid_input', `Invalid header ${name.slice(0, 64)}`);
    if (RESERVED_HEADERS.test(name)) throw new PluginSdkError('invalid_input', `Header ${name} is set by ProPR`);
    headers[name.toLowerCase()] = value;
  }
  return headers;
}

function requestBody(init: PluginHttpRequestInit, headers: Record<string, string>): Buffer | undefined {
  if (init.body !== undefined && init.json !== undefined) throw new PluginSdkError('invalid_input', 'Pass either body or json, not both');
  let body: Buffer | undefined;
  if (init.json !== undefined) {
    body = Buffer.from(JSON.stringify(init.json));
    headers['content-type'] ??= 'application/json';
  } else if (init.body !== undefined) {
    if (typeof init.body !== 'string') throw new PluginSdkError('invalid_input', 'body must be text');
    body = Buffer.from(init.body);
  }
  if (body && body.length > PLUGIN_HTTP_LIMITS.requestBytes) throw new PluginSdkError('invalid_input', `Request bodies are at most ${PLUGIN_HTTP_LIMITS.requestBytes} bytes`);
  return body;
}

/** The default transport: dial only the vetted address with the original TLS identity; no redirects, proxies, cookies or decompression. */
export const httpsPluginTransport: PluginHttpTransport = request => new Promise((resolve, reject) => {
  const host = request.url.hostname;
  const failed = (message = `Request to ${host} failed`) => reject(new PluginSdkError('http_failed', message));
  if (request.signal?.aborted) { reject(ended()); return; }
  const outgoing = https.request({
    host: request.address, family: request.family, port: 443, path: `${request.url.pathname}${request.url.search}`,
    method: request.method, agent: false, servername: host,
    lookup: (_host, _options, callback) => callback(null, request.address, request.family),
    headers: { ...request.headers, host: request.url.host, ...(request.body ? { 'content-length': String(request.body.length) } : {}) },
  }, response => {
    const chunks: Buffer[] = []; let bytes = 0;
    response.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > request.maxResponseBytes) { response.destroy(); reject(new PluginSdkError('response_too_large', `Responses are at most ${request.maxResponseBytes} bytes`)); } else chunks.push(chunk);
    });
    response.on('error', () => failed());
    response.on('end', () => {
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(response.headers)) if (value !== undefined) headers[name] = Array.isArray(value) ? value.join(', ') : value;
      resolve({ status: response.statusCode ?? 0, headers, body: Buffer.concat(chunks) });
    });
  });
  const timer = setTimeout(() => { outgoing.destroy(); failed(`Request to ${host} timed out`); }, request.timeoutMs);
  // The handler run ended: stop sending and receiving.
  const abort = () => { outgoing.destroy(); reject(ended()); };
  request.signal?.addEventListener('abort', abort, { once: true });
  outgoing.on('close', () => { clearTimeout(timer); request.signal?.removeEventListener('abort', abort); });
  outgoing.on('error', () => failed());
  outgoing.end(request.body);
});

function bufferedResponse(url: URL, response: PluginHttpTransportResponse, spellings: readonly CredentialSpelling[]): PluginHttpResponse {
  const text = scrubbedBody(response.body.toString('utf8'), spellings);
  // A header whose name echoes the credential is dropped: the handler can read names as well as values.
  const headers = Object.fromEntries(Object.entries(response.headers)
    .map(([name, value]) => [name.toLowerCase(), value] as const)
    .filter(([name]) => !nameRevealsCredential(name, spellings))
    .map(([name, value]) => [name, scrubbedHeader(value, spellings)]));
  return {
    status: response.status, ok: response.status >= 200 && response.status < 300, url: url.toString(), headers,
    text: async () => text,
    json: async <T>() => {
      try { return JSON.parse(text) as T; } catch { throw new PluginSdkError('http_failed', 'The response is not JSON'); }
    },
  };
}

/**
 * `ctx.http`: outbound HTTPS to the manifest's `outboundHosts` only, through
 * the extension endpoint policy (public addresses only, the checked address
 * is the one dialed), with bounded request and response sizes and time. A
 * credential is injected as `Authorization: Bearer` and scrubbed from the
 * response, so the handler never sees it.
 */
export function createPluginHttp(options: PluginHttpOptions): PluginHttpFetch {
  const lookup = options.lookup ?? defaultLookup;
  const transport = options.transport ?? httpsPluginTransport;
  let credential: Promise<string | null> | undefined;
  return async (value, init = {}) => {
    // Only the hostname is ever logged: a refused URL may carry credentials or a query.
    let host = '(invalid URL)';
    try { host = new URL(String(value)).hostname || host; } catch { /* stays invalid */ }
    try {
      const url = vetUrl(value, options.outboundHosts);
      const method = (init.method ?? 'GET').toUpperCase();
      if (!METHODS.has(method)) throw new PluginSdkError('invalid_input', `Method ${String(init.method).slice(0, 16)} is not allowed`);
      const headers = requestHeaders(init);
      const body = requestBody(init, headers);
      const { signal } = options;
      checkLive(signal);
      const { address, family } = await untilEnded(resolvePublic(host, lookup), signal);
      credential ??= options.credential ? options.credential() : Promise.resolve(null);
      const secret = await untilEnded(credential, signal);
      if (secret) headers.authorization = `Bearer ${secret}`;
      if (options.authorize) await untilEnded(options.authorize(), signal);
      // The run may have ended during the lookups: nothing is sent for an ended handler.
      checkLive(signal);
      options.onDecision?.({ host, allowed: true });
      const response = await untilEnded(transport({ url, address, family, method, headers, body, timeoutMs: PLUGIN_HTTP_LIMITS.timeoutMs, maxResponseBytes: PLUGIN_HTTP_LIMITS.responseBytes, signal }), signal);
      checkLive(signal);
      return bufferedResponse(url, response, secret ? credentialSpellings(secret) : []);
    } catch (error) {
      const refused = error instanceof PluginSdkError ? error : new PluginSdkError('http_failed', `Request to ${host} failed`);
      options.onDecision?.({ host, allowed: false, reason: refused.code });
      throw refused;
    }
  };
}
