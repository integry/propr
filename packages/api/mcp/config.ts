import { redactDetails, redactSecrets, type McpErrorEnvelope, type McpErrorStage } from './errorEnvelope.js';

export const MCP_SCOPES = ['read', 'plan', 'publish', 'execute', 'review', 'merge', 'deploy', 'manage'] as const;
export type McpScope = typeof MCP_SCOPES[number];

export interface McpConfig {
  origin: string;
  resource: string;
  instanceId: string;
  encryptionKey: Buffer;
  /** Admin-configured upper bound on grantable scopes. Absent means every scope is grantable. */
  scopeCeiling?: McpScope[];
  connect?: { issuer: string; jwks: string; installationId: number; resource: string; tunnelId: string; relayToken: string };
}

function httpsUrl(value: string | undefined, name: string): string {
  if (!value) throw new Error(`MCP: ${name} is required`);
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) {
    throw new Error(`MCP: ${name} must be an HTTPS URL without credentials, query or fragment`);
  }
  return url.href;
}

export function loadMcpConfig(env: NodeJS.ProcessEnv = process.env): McpConfig | undefined {
  if (env.MCP_ENABLED !== 'true') return undefined;
  const origin = new URL(httpsUrl(env.MCP_PUBLIC_ORIGIN, 'MCP_PUBLIC_ORIGIN')).origin;
  if (new URL(env.MCP_PUBLIC_ORIGIN!).pathname !== '/') throw new Error('MCP_PUBLIC_ORIGIN must have no path');
  if (!env.MCP_INSTANCE_ID || !/^[a-zA-Z0-9_-]{8,128}$/.test(env.MCP_INSTANCE_ID)) throw new Error('MCP_INSTANCE_ID must be a stable 8–128 character identifier');
  const encryptionKey = Buffer.from(env.MCP_ENCRYPTION_KEY || '', 'base64');
  if (encryptionKey.length !== 32) throw new Error('MCP_ENCRYPTION_KEY must contain 32 random bytes encoded as base64');
  const config: McpConfig = { origin, resource: `${origin}/api/mcp`, instanceId: env.MCP_INSTANCE_ID, encryptionKey };
  if (env.MCP_CONNECT_TRUST === 'true') {
    config.connect = loadConnectConfig(env, config.instanceId);
  }
  return config;
}

/** Largest serialized tool result (`data`) the executor returns; larger results are RESULT_TOO_LARGE. */
export const MAX_TOOL_RESULT_BYTES = 256 * 1024;

export class McpError extends Error {
  readonly stage: McpErrorStage | null;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
    options: { stage?: McpErrorStage | null; retryable?: boolean; details?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = 'McpError';
    this.stage = options.stage ?? null;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }

  toEnvelope(): McpErrorEnvelope {
    return {
      code: this.code,
      message: redactSecrets(this.message),
      stage: this.stage,
      retryable: this.retryable,
      status: this.status,
      ...(this.details ? { details: redactDetails(this.details) } : {}),
    };
  }
}

function loadConnectConfig(env: NodeJS.ProcessEnv, instanceId: string): McpConfig['connect'] {
  const installationId = Number(env.GH_INSTALLATION_ID);
  // Existing tunnel setup stores the registry UUID in PROPR_INSTANCE_ID. It
  // is a routing address, separate from the persistent MCP instance identity.
  const tunnelId = env.MCP_CONNECT_TUNNEL_ID || env.PROPR_INSTANCE_ID;
  if (!/^[1-9][0-9]*$/.test(env.GH_INSTALLATION_ID || '') || !Number.isSafeInteger(installationId) || installationId <= 0 || !env.PROPR_GH_RELAY_TOKEN?.startsWith('prt_')
    || !tunnelId || !/^[a-zA-Z0-9_-]{1,100}$/.test(tunnelId) || env.PROPR_UI_TUNNEL_ENABLED !== 'true' || !env.PROPR_UI_TUNNEL_TOKEN) {
    throw new Error('MCP Connect requires GH_INSTALLATION_ID, PROPR_GH_RELAY_TOKEN, PROPR_INSTANCE_ID (or MCP_CONNECT_TUNNEL_ID) and an enabled configured UI tunnel');
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{15,99}$/.test(instanceId)) throw new Error('Connect instance identity must be a persistent 16–100 character identifier');
  const issuer = httpsUrl(env.MCP_CONNECT_ISSUER || 'https://mcp.propr.dev', 'MCP_CONNECT_ISSUER').replace(/\/$/, '');
  if (new URL(issuer).pathname !== '/') throw new Error('MCP_CONNECT_ISSUER must be a bare HTTPS origin');
  return { issuer, jwks: `${issuer}/.well-known/jwks.json`, resource: `${issuer}/mcp`,
    installationId, tunnelId, relayToken: env.PROPR_GH_RELAY_TOKEN };
}
