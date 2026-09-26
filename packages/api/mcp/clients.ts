import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';
import { InvalidClientMetadataError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { OAuthClientMetadataSchema, type OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import { McpStore } from './store.js';

const PUBLIC_GRANT_TYPES = ['authorization_code', 'refresh_token'];

function publicAddress(address: string): boolean {
  // Reject special-use ranges and IPv6 transition/mapped forms. DNS is pinned
  // to the validated address for the HTTPS connection, preventing rebinding.
  if (isIP(address) === 6) return /^2[0-9a-f]{3}:/i.test(address) && !/^200[12]:/i.test(address);
  const [a, b] = address.split('.').map(Number);
  return isIP(address) === 4 && a > 0 && a < 224 && a !== 10 && a !== 127 && a !== 192
    && !(a === 169 && b === 254) && !(a === 172 && b >= 16 && b <= 31)
    && !(a === 100 && b >= 64 && b <= 127) && !(a === 198 && (b === 18 || b === 19));
}

async function fetchMetadata(url: URL): Promise<unknown> {
  const signal = AbortSignal.timeout(5000);
  const addresses = await Promise.race([lookup(url.hostname, { all: true }), new Promise<never>((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new InvalidClientMetadataError('Client metadata lookup timed out')), { once: true });
  })]);
  if (!addresses.length || addresses.some(entry => !publicAddress(entry.address))) throw new InvalidClientMetadataError('Client metadata must use a public HTTPS host');
  const address = addresses[0];
  return new Promise((resolve, reject) => {
    const req = request(url, {
      signal,
      family: address.family,
      lookup: (_host, _options, callback) => callback(null, address.address, address.family),
      headers: { Accept: 'application/json' }, timeout: 5000,
    }, response => {
      if (response.statusCode !== 200 || !response.headers['content-type']?.includes('application/json')) {
        response.resume(); reject(new InvalidClientMetadataError('Client metadata must return JSON without redirects')); return;
      }
      let size = 0;
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 32768) { response.destroy(); reject(new InvalidClientMetadataError('Client metadata exceeds 32 KiB')); }
        else chunks.push(chunk);
      });
      response.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch { reject(new InvalidClientMetadataError('Invalid client metadata JSON')); } });
      response.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('Client metadata timeout')));
    req.on('error', reject);
    req.end();
  });
}

export function validatePublicClient(client: OAuthClientInformationFull): OAuthClientInformationFull {
  if (client.token_endpoint_auth_method !== 'none' || client.redirect_uris.length < 1 || client.redirect_uris.length > 10) {
    throw new InvalidClientMetadataError('Only public clients with 1–10 exact redirect URIs are supported');
  }
  if ((client.grant_types !== undefined && (!Array.isArray(client.grant_types) || !client.grant_types.length || client.grant_types.some(value => !['authorization_code', 'refresh_token'].includes(value))))
    || (client.response_types !== undefined && (!Array.isArray(client.response_types) || !client.response_types.length || client.response_types.some(value => value !== 'code')))) {
    throw new InvalidClientMetadataError('Only authorization-code and rotating refresh grants are supported');
  }
  for (const value of client.redirect_uris) {
    const url = new URL(value);
    if (url.hash || url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)))) {
      throw new InvalidClientMetadataError('Redirects must use HTTPS or HTTP loopback without credentials or fragments');
    }
  }
  return { ...client, client_secret: undefined, grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] };
}

function selectGrantTypes(advertised: unknown): string[] | undefined {
  if (advertised === undefined) return undefined;
  if (!Array.isArray(advertised) || !advertised.length || advertised.length > 32
    || advertised.some(grant => typeof grant !== 'string' || !grant || /\s/.test(grant))) {
    throw new InvalidClientMetadataError('Malformed client grant capabilities');
  }
  const selected = PUBLIC_GRANT_TYPES.filter(grant => advertised.includes(grant));
  if (!selected.includes('authorization_code')) {
    throw new InvalidClientMetadataError('Client does not support authorization-code grants');
  }
  return selected;
}

export function parseClientMetadataDocument(document: Record<string, unknown>, id: string): OAuthClientInformationFull {
  if (document.client_id !== id) throw new InvalidClientMetadataError('Client metadata ID mismatch');
  // CIMD fields advertise the client's capabilities, which can be broader than
  // this authorization server. Intersect them with the flows we actually use.
  const supported = document.token_endpoint_auth_methods_supported;
  const preference = document.token_endpoint_auth_method;
  const advertisedGrants = document.grant_types;
  if (supported !== undefined && (!Array.isArray(supported) || !supported.length || supported.length > 32
    || supported.some(method => typeof method !== 'string' || !method || /\s/.test(method)) || !supported.includes('none'))) {
    throw new InvalidClientMetadataError('Client does not support public PKCE authentication or has malformed capabilities');
  }
  if (preference !== undefined && (typeof preference !== 'string' || !preference || /\s/.test(preference))) {
    throw new InvalidClientMetadataError('Invalid legacy authentication method preference');
  }
  const grantTypes = selectGrantTypes(advertisedGrants);
  const parsed = OAuthClientMetadataSchema.parse({ ...document,
    ...(Array.isArray(supported) || preference === undefined ? { token_endpoint_auth_method: 'none' } : {}),
    ...(grantTypes ? { grant_types: grantTypes } : {}),
  });
  return validatePublicClient({ ...parsed, client_id: id });
}

export function createClientsStore(store: McpStore): OAuthRegisteredClientsStore {
  return {
    async getClient(id) {
      if (!id.startsWith('https://')) return store.get<OAuthClientInformationFull>('client', id);
      const url = new URL(id);
      if (url.hash || url.username || url.password || url.port || url.pathname === '/') throw new InvalidClientMetadataError('Invalid client metadata URL');
      const cached = await store.get<OAuthClientInformationFull>('cimd', id);
      if (cached) return cached;
      const document = await fetchMetadata(url) as Record<string, unknown>;
      const client = parseClientMetadataDocument(document, id);
      await store.put('cimd', id, client, { expiresAt: Date.now() + 300_000 });
      return client;
    },
    async registerClient(metadata) {
      const client = validatePublicClient({ ...metadata, client_id: randomUUID(), client_id_issued_at: Math.floor(Date.now() / 1000) });
      await store.put('client', client.client_id, client);
      return client;
    },
  };
}
