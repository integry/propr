import { EXTENSION_LIMITS } from '@propr/shared';
import { ExtensionError, ExtensionProfileStore, extensionTokenHash } from './extensionProfileStore.js';
import { requestExtensionMcp, extensionResponseWireBytes, resolveExtensionEndpoint } from './endpointPolicy.js';
import { redactExtensionOutput } from './extensionOutput.js';
export { redactExtensionOutput } from './extensionOutput.js';

// eslint-disable-next-line max-params, complexity -- protocol validation, policy enforcement and budget release share one gateway boundary
export async function extensionGatewayCall(store: ExtensionProfileStore, token: string, serverName: string, body: unknown, send = requestExtensionMcp): Promise<unknown> {
  const { snapshot, secrets, network, allowWrite } = await store.grantSnapshot(token);
  // Failed/oversized requests consume the full reservation, so failures cannot
  // bypass the run budget. Successful responses charge actual wire bytes,
  // including whitespace that disappears during JSON parsing.
  let responseBytes: number = EXTENSION_LIMITS.responseBytes;
  let recordedDecision = false;
  let decision: { host: string; allowed: boolean } | undefined;
  try {
  const server = snapshot.mcpServers.find(s => s.enabled && s.name === serverName);
  if (!server || !body || typeof body !== 'object' || Array.isArray(body)) throw new ExtensionError(403, 'MCP capability unavailable');
  if (server.capability === 'write' && !allowWrite) throw new ExtensionError(403, 'Run write grant unavailable');
  const rpc = body as Record<string, unknown>;
  if (rpc.jsonrpc !== '2.0' || Object.keys(rpc).some(k => !['jsonrpc', 'id', 'method', 'params'].includes(k)) || !(rpc.id === undefined || typeof rpc.id === 'string' || typeof rpc.id === 'number') || !['initialize', 'ping', 'notifications/initialized', 'tools/list', 'tools/call'].includes(String(rpc.method))) throw new ExtensionError(403, 'MCP method unavailable');
  const params = rpc.params as Record<string, unknown> | undefined;
  if (rpc.method === 'tools/call' && (!params || typeof params.name !== 'string' || !server.tools.includes(params.name) || Object.keys(params).some(k => !['name', 'arguments', '_meta'].includes(k)))) throw new ExtensionError(403, 'MCP tool unavailable');
  // Stateful upstream MCP is intentionally unsupported: no upstream session
  // headers/cookies or reverse requests can extend a run's capabilities.
  let upstream: unknown;
  const forwarded = rpc.method === 'tools/call' ? { ...rpc, params: { name: params!.name, ...(params!.arguments === undefined ? {} : { arguments: params!.arguments }) } } : rpc;
  const entry = server.kind === 'catalog' ? await store.catalog.resolve(server.catalogId, server.digest, server.tools, server.capability) : undefined;
  if (entry?.kind === 'stdio') throw new ExtensionError(403, 'Local catalog tools require the selected task container');
  const endpoint = server.kind === 'https' ? server.url : entry!.kind === 'https' ? entry!.url : '';
  const operatorToken = entry?.kind === 'https' ? store.catalog.secrets(entry).bearerToken : undefined;
  if (operatorToken) secrets[serverName] = operatorToken;
  const recordDecision = async () => {
    if (decision && !recordedDecision) {
      await store.recordGatewayNetwork(token, decision.host, decision.allowed);
      recordedDecision = true;
    }
  };
  const policy = { network, ...(entry?.kind === 'https' ? { internalAddresses: entry.addresses } : {}), onDecision: async (host: string, allowed: boolean) => {
    decision = { host: server.kind === 'catalog' ? `catalog:${server.catalogId}@${server.digest}` : host, allowed };
    await recordDecision();
  } };
  // Check even with an injected transport; the real transport resolves again and
  // pins the checked address immediately before TLS dialing.
  await resolveExtensionEndpoint(endpoint, undefined, { ...policy, onDecision: async (host, allowed) => {
    decision = { host: server.kind === 'catalog' ? `catalog:${server.catalogId}@${server.digest}` : host, allowed };
    // Successful prechecks are recorded by the physical transport. A denied
    // precheck never reaches that transport and must be retained here.
    if (!allowed) await recordDecision();
  } });
  await store.database('extension_run_grants').where({ token_hash: extensionTokenHash(token) }).increment('request_bytes', Buffer.byteLength(JSON.stringify(forwarded)));
  try { upstream = await send(endpoint, forwarded, secrets[serverName], policy); } catch { throw new ExtensionError(502, 'MCP connection failed'); }
  if (upstream === null && rpc.id === undefined) { responseBytes = 0; return null; }
  if (!upstream || typeof upstream !== 'object' || Array.isArray(upstream)) throw new ExtensionError(502, 'MCP protocol unavailable');
  responseBytes = extensionResponseWireBytes(upstream) ?? EXTENSION_LIMITS.responseBytes;
  const result = upstream as Record<string, unknown>;
  if (result.jsonrpc !== '2.0' || result.id !== rpc.id) throw new ExtensionError(502, 'MCP request failed');
  if (Object.hasOwn(result, 'error')) {
    const error = result.error as { code?: unknown; message?: unknown } | null;
    if (Object.hasOwn(result, 'result') || !error || typeof error !== 'object' || Array.isArray(error) || !Number.isSafeInteger(error.code) || typeof error.message !== 'string') throw new ExtensionError(502, 'MCP protocol unavailable');
    // Upstream messages/data are untrusted and may contain credentials or
    // operator details. Preserve only the protocol code, as the stdio bridge does.
    return { jsonrpc: '2.0', id: rpc.id, error: { code: error.code, message: 'MCP request failed' } };
  }
  if (!Object.hasOwn(result, 'result')) throw new ExtensionError(502, 'MCP request failed');
  let projection = result.result;
  if (rpc.method === 'initialize') {
    projection = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: server.name, version: '1' } };
  } else if (rpc.method === 'tools/list') {
    const tools = (projection as { tools?: unknown[] })?.tools;
    if (!Array.isArray(tools) || tools.length > 64) throw new ExtensionError(502, 'MCP tool catalog unavailable');
    projection = { tools: tools.filter(t => t && typeof t === 'object' && server.tools.includes(String((t as { name?: unknown }).name))) };
  }
  const redacted = redactExtensionOutput({ jsonrpc: '2.0', id: rpc.id, result: projection }, [...Object.values(secrets), token]);
  if (Buffer.byteLength(JSON.stringify(redacted)) > EXTENSION_LIMITS.responseBytes) throw new ExtensionError(502, 'MCP response too large');
  return redacted;
  } finally {
    try { if (decision && !recordedDecision) await store.recordGatewayNetwork(token, decision.host, decision.allowed); }
    finally { await store.finishGatewayCall(token, responseBytes); }
  }
}
