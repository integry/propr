import { ExtensionError, type ExtensionLibraryStore } from './extensionProfileStore.js';
import { extensionRequestFailureReason, requestExtensionMcp, type ExtensionMcpSend } from './endpointPolicy.js';
import { ExtensionUpstreamHandshakeIncompleteError, ExtensionUpstreamHandshakeUnauthorizedError, probeExtensionMcp, type UpstreamAuthentication, type UpstreamSessionMode } from './mcpUpstreamSessions.js';
import { extensionOAuth } from './extensionOAuthStore.js';
import { OAuthProtocolError } from './extensionOAuth.js';
import { OAuthNetworkError } from './extensionOAuthHttp.js';

export type ExtensionConnectionTestResult =
  | { name: string; reachable: null; status: 'not_validated' }
  | { name: string; reachable: boolean; status: 'reachable' | 'unavailable'; session: UpstreamSessionMode | null; authentication: UpstreamAuthentication; reason?: string };

/**
 * Why an OAuth server's access token could not be had. The messages here are fixed strings that name no token, URL
 * or provider response.
 */
function credentialFailureReason(error: unknown): string {
  if (error instanceof ExtensionError && error.message === 'OAuth connection unavailable') return 'OAuth not connected';
  if (error instanceof OAuthProtocolError && error.authorization) return 'token refresh refused: sign in again';
  if (error instanceof OAuthNetworkError || error instanceof OAuthProtocolError) return 'token refresh failed';
  return 'OAuth access token unavailable';
}

/** Why a probe threw: a refused credential, an incomplete handshake, or a transport failure. */
function probeFailureReason(error: unknown): string {
  if (error instanceof ExtensionUpstreamHandshakeIncompleteError) return error.reason;
  if (error instanceof ExtensionUpstreamHandshakeUnauthorizedError) return 'credential refused (HTTP 401) on notifications/initialized';
  return extensionRequestFailureReason(error);
}

/**
 * Settings' Test connections: one handshake per enabled URL server, as the gateway would open it, then ended. Nothing
 * is kept, and it never touches the gateway's per-run sessions. An `unavailable` result carries a short, secret-free
 * `reason` (an HTTP status, a timeout, a failed token refresh); no upstream response content is disclosed.
 */
export async function testExtensionConnections(store: ExtensionLibraryStore, actor: string, send: ExtensionMcpSend = requestExtensionMcp): Promise<ExtensionConnectionTestResult[]> {
  const { servers, secrets } = await store.validationTargets(actor);
  const instanceId = await store.instanceId();
  const results: ExtensionConnectionTestResult[] = [];
  for (const server of servers) {
    // Catalog and package servers run inside the task container; nothing is started here.
    if (server.kind !== 'https') { results.push({ name: server.name, reachable: null, status: 'not_validated' }); continue; }
    // Session mode comes from the upstream's answer; authentication from the server's setting.
    const unavailable = (reason: string): ExtensionConnectionTestResult => ({ name: server.name, reachable: false, status: 'unavailable', session: null, authentication: server.authentication, reason });
    let credential: string | undefined;
    // An OAuth server is tested with its current access token; its library secret is a client secret, never sent upstream.
    try { credential = server.authentication === 'oauth' ? await extensionOAuth(store).accessToken(instanceId, server) : secrets[server.name]; }
    catch (error) { results.push(unavailable(credentialFailureReason(error))); continue; }
    try {
      const probe = await probeExtensionMcp(server.url, credential, {}, send);
      results.push(probe.reachable
        ? { name: server.name, reachable: true, status: 'reachable', session: probe.session, authentication: server.authentication }
        : unavailable(probe.reason ?? 'no MCP handshake completed'));
    } catch (error) { results.push(unavailable(probeFailureReason(error))); }
  }
  return results;
}
