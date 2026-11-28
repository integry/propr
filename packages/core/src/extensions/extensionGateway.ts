import { ExtensionError } from './extensionProfileStore.js';

/** Reuse the existing container-reachable Core MCP URL, including a reverse
 * proxy path prefix. Operator URLs never put authentication values in args. */
export function extensionGatewayBaseUrl(environment: NodeJS.ProcessEnv = process.env, mcpEndpoint?: string): string {
  // A remote runtime reaches ProPR MCP at its own reachable URL; the gateway sits beside it.
  const endpoint = mcpEndpoint || environment.PROPR_AGENT_MCP_URL || `${(environment.PROPR_INTERNAL_API_URL || 'http://api:4000').replace(/\/+$/, '')}/api/mcp`;
  let url: URL; try { url = new URL(endpoint); } catch { throw new ExtensionError(503, 'Core gateway URL is invalid'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !/\/api\/mcp\/?$/.test(url.pathname)) throw new ExtensionError(503, 'Core gateway URL must name the credential-free Core MCP endpoint');
  url.pathname = url.pathname.replace(/\/api\/mcp\/?$/, '/api/extensions/mcp');
  return url.toString();
}

/** The gateway URL, or undefined when it cannot be derived from this endpoint. */
export function tryExtensionGatewayBaseUrl(environment: NodeJS.ProcessEnv, mcpEndpoint?: string): string | undefined {
  try { return extensionGatewayBaseUrl(environment, mcpEndpoint); }
  catch { return undefined; }
}
