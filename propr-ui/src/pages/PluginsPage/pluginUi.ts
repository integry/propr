import type { PublicPluginMcpServer } from '@propr/shared';
import type { PluginManifestView, PluginView } from '../../api/pluginsApi';

export { buttonClass, dangerButtonClass, inputClass, primaryButtonClass } from '../SettingsPage/extensions/extensionUi';

export { canManagePlugins } from '../SettingsPage/settingsPermissions';

/** Where an enabled plugin's managed items are listed and edited. */
export const EXTENSION_LIBRARY_PATH = '/settings?tab=agent-extensions';
export const PLUGINS_PATH = '/plugins';
export const pluginPath = (id: string) => `${PLUGINS_PATH}/${encodeURIComponent(id)}`;

export const CATEGORY_LABELS: Record<PluginManifestView['category'], string> = {
  messaging: 'Messaging', 'issue-tracking': 'Issue tracking', observability: 'Observability',
  deployment: 'Deployment', context: 'Context', other: 'Other',
};

export type PluginBadge = 'not_installed' | 'enabled' | 'off' | 'needs_connection' | 'needs_approval' | 'degraded';
export const BADGES: Record<PluginBadge, { label: string; className: string }> = {
  not_installed: { label: 'Not installed', className: 'bg-slate-100 text-slate-700' },
  enabled: { label: 'Enabled', className: 'bg-teal-50 text-teal-800' },
  off: { label: 'Off', className: 'bg-slate-200 text-slate-700' },
  needs_connection: { label: 'Needs connection', className: 'bg-amber-100 text-amber-900' },
  needs_approval: { label: 'Needs approval', className: 'bg-amber-100 text-amber-900' },
  degraded: { label: 'Degraded', className: 'bg-red-50 text-red-800' },
};

const disconnected = (view: PluginView) => view.connections.some(c => c.state !== 'connected');

/**
 * The one state badge of a plugin. An upgrade awaiting approval wins; an
 * enabled plugin missing a connection, or no longer in the registry, is
 * degraded; a disabled one missing a connection needs it.
 */
export function pluginBadge(view: PluginView): PluginBadge {
  if (!view.installation) return 'not_installed';
  if (view.needsApproval) return 'needs_approval';
  if (!view.available) return 'degraded';
  if (view.installation.enabled) return disconnected(view) ? 'degraded' : 'enabled';
  return disconnected(view) ? 'needs_connection' : 'off';
}

/** Only `https` URLs become links; anything else from a manifest is shown as text or not at all. */
export function safeHttpsUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try { return new URL(value).protocol === 'https:' ? value : null; } catch { return null; }
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
export const mcpServersOf = (manifest: PluginManifestView) => manifest.contributes.mcpServers as unknown as PublicPluginMcpServer[];
export type PluginPackageSecretServer = Extract<PublicPluginMcpServer, { kind: 'package' }>;
/** Package servers that hand secret variables to the task container. */
export const packageSecretServers = (manifest: PluginManifestView): PluginPackageSecretServer[] =>
  mcpServersOf(manifest).flatMap(server => (server.kind === 'package' && server.secretEnv.length ? [server] : []));

/** What a plugin adds, in plain words, generated from its manifest. */
export function describePluginContributions(manifest: PluginManifestView): string[] {
  const servers = mcpServersOf(manifest);
  const remote = servers.filter(s => s.kind === 'https');
  const read = remote.filter(s => s.capability === 'read').length;
  const write = remote.length - read;
  const local = servers.filter(s => s.kind === 'package').length;
  const { skills, automationTemplates, commands, subscriptions, webhooks } = manifest.contributes;
  const lines: string[] = [];
  if (read) lines.push(`Adds ${count(read, 'MCP server', 'MCP servers')} the agent can read from`);
  if (write) lines.push(`Adds ${count(write, 'MCP server', 'MCP servers')} the agent can read from and write to`);
  if (local) lines.push(`Runs ${count(local, 'local server', 'local servers')} inside the task container`);
  if (skills.length) lines.push(`Adds ${count(skills.length, 'skill', 'skills')} the agent reads when relevant: ${skills.join(', ')}`);
  if (automationTemplates.length) lines.push(`Adds ${count(automationTemplates.length, 'automation template', 'automation templates')}: ${automationTemplates.join(', ')}`);
  for (const command of commands) lines.push(`Adds the /${command.name} command`);
  if (subscriptions.length) lines.push(`Receives ProPR events: ${subscriptions.join(', ')}`);
  if (webhooks.length) lines.push(`Receives ${count(webhooks.length, 'webhook', 'webhooks')} from a service`);
  if (manifest.outboundHosts.length) lines.push(`Sends requests to ${manifest.outboundHosts.join(', ')}`);
  return lines.length ? lines : ['Adds nothing the agent uses yet'];
}

/** The acknowledgement text of one package server: its package, exact version and variable names. */
export function secretAcknowledgementText(server: { package: string; version: string; secretEnv: string[] }) {
  const variables = server.secretEnv.join(', ');
  return `I understand that ${server.package}@${server.version} receives ${server.secretEnv.length === 1 ? 'the secret variable' : 'the secret variables'} ${variables}, `
    + 'and that they are readable by the agent CLI, its shell tools and repository setup scripts inside the task container.';
}

export const formatWhen = (at: number) => new Date(at).toLocaleString();
