import { z } from 'zod';
import type { PluginView } from '@propr/shared';
import { PluginError, PluginStore } from '../../core/src/plugins/pluginStore.js';
import { McpError } from './config.js';
import { type McpTool, type ToolDeps, ok } from './tools.js';

/** The compact list row: state and what needs the administrator, without settings or the manifest body. */
const summary = (plugin: PluginView) => ({
  id: plugin.id, name: plugin.manifest?.name ?? plugin.id, category: plugin.manifest?.category ?? null,
  availableVersion: plugin.manifest?.version ?? null, installedVersion: plugin.installation?.installedVersion ?? null,
  available: plugin.available, state: plugin.state, needsApproval: plugin.needsApproval,
  pendingPermissions: plugin.pendingPermissions, enableBlockers: plugin.enableBlockers,
  connections: plugin.connections.map(c => ({ name: c.name, type: c.type, state: c.state, required: c.required })),
});

async function read<T>(run: () => Promise<T>): Promise<T> {
  try { return await run(); } catch (error) {
    if (!(error instanceof PluginError)) throw error;
    throw new McpError(error.status === 404 ? 'NOT_FOUND' : error.status === 403 ? 'FORBIDDEN' : 'PRECONDITION_FAILED', error.message, error.status);
  }
}

/** Read-only plugin state for instance settings administrators. Install and configure in Settings or through the REST API. */
export function addPluginTools(tools: McpTool[], deps: ToolDeps): void {
  const store = new PluginStore(deps.db);
  const permission = 'instance.manage_settings' as const;
  tools.push({
    name: 'list_plugins', description: 'List the plugins this ProPR offers and their installation state: installed, enabled, Needs approval, why enabling is refused and connection states. Never returns secrets.',
    scope: 'manage', permission, readOnly: true, schema: z.object({}).strict(),
    run: async ({ principal }) => ok({ plugins: (await read(() => store.list(principal.user.id))).map(summary) }),
  });
  tools.push({
    name: 'get_plugin', description: 'Read one plugin: its manifest, settings, repository limit, granted and pending permissions, connection states, pending secret acknowledgements and recent audit events. Never returns secrets.',
    scope: 'manage', permission, readOnly: true, schema: z.object({ pluginId: z.string().min(1).max(48).describe('Plugin id, for example example-pack.') }).strict(),
    run: async ({ principal, args }) => ok({ plugin: await read(() => store.get(principal.user.id, args.pluginId)) }),
  });
}
