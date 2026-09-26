/** Operator-only entry point. Load the same environment and database as the API. */
import 'dotenv/config';
import { loadMcpConfig } from '../packages/api/mcp/config.js';
import { McpStore } from '../packages/api/mcp/store.js';
import { registerMcpInstance } from '../packages/api/mcp/connect.js';
import { db, closeConnection } from '@propr/core';

try {
  const config = loadMcpConfig();
  if (!config?.connect) throw new Error('Enable MCP and explicitly set MCP_CONNECT_TRUST=true in the instance environment first.');
  if (!await db.schema.hasTable('mcp_records')) throw new Error('Run instance database migrations before MCP registration.');
  const store = new McpStore(db, config.encryptionKey);
  await registerMcpInstance(config, store);
  console.log(`Registered instance ${config.instanceId} for ${config.connect.resource}. Obtain fresh browser consent if the target changed.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : 'MCP registration failed');
  process.exitCode = 1;
} finally { await closeConnection(); }
