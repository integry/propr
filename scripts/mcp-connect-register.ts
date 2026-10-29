/** Operator-only entry point. Load the same environment and database as the API. */
import 'dotenv/config';
import { loadMcpConfig } from '../packages/api/mcp/config.js';
import { loadHostedTunnelMcpConfig } from '../packages/api/mcp/configResolver.js';
import { McpStore } from '../packages/api/mcp/store.js';
import { registerMcpInstance } from '../packages/api/mcp/connect.js';
import { isHostedTunnelMode, isTunnelDerivedInstanceId } from '../packages/api/mcp/tunnelMode.js';
import { db, closeConnection } from '@propr/core';

try {
  if (!await db.schema.hasTable('mcp_records')) throw new Error('Run instance database migrations before MCP registration.');
  // Hosted UI tunnel mode derives the same configuration the API uses, so this
  // command repairs an automatic registration with no MCP_* settings.
  const hostedTunnel = isHostedTunnelMode(process.env) && process.env.MCP_ENABLED !== 'false';
  const config = hostedTunnel ? await loadHostedTunnelMcpConfig(db, process.env) : loadMcpConfig();
  if (!config?.connect) {
    throw new Error(hostedTunnel
      ? 'MCP_CONNECT_TRUST=false disables ProPR Connect for this instance.'
      : 'Enable MCP and explicitly set MCP_CONNECT_TRUST=true in the instance environment first, or use the hosted UI tunnel.');
  }
  const store = new McpStore(db, config.encryptionKey);
  await registerMcpInstance(config, store, { replaceIdentity: isTunnelDerivedInstanceId(process.env) });
  console.log(`Registered instance ${config.instanceId} for ${config.connect.resource}. Obtain fresh browser consent if the target changed.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : 'MCP registration failed');
  process.exitCode = 1;
} finally { await closeConnection(); }
