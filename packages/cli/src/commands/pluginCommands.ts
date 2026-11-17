/**
 * `propr plugin list` and `propr plugin show <id>`: read-only views of the
 * official plugins and their installation on the connected ProPR, through
 * the plugin REST API (`/api/instance/plugins/v1`). Both need an instance
 * administrator, as the Plugins page does. Installing, configuring and
 * enabling stay on the Plugins page.
 */

import { Command } from "commander";
import type { PluginDetail, PluginView } from "@propr/shared";
import { getPlugin, listPlugins } from "../api/plugins.js";
import type { ApiClient } from "../api/client.js";
import { ApiError } from "../api/errors.js";
import { presentApiError } from "../utils/apiErrorPresentation.js";

const FORBIDDEN = "Error: Access denied. Plugins need an instance administrator with the instance.manage_settings permission.";

/** The state column: available, installed or enabled, and what waits on an administrator. */
export function pluginStateLabel(plugin: PluginView): string {
  const notes = [
    ...(plugin.available ? [] : ["removed from this ProPR version"]),
    ...(plugin.needsApproval ? ["needs approval"] : []),
  ];
  return notes.length ? `${plugin.state} (${notes.join(", ")})` : plugin.state;
}

const repositories = (plugin: PluginView): string => {
  const limit = plugin.installation?.repositories;
  if (!plugin.installation) return "-";
  return limit === null || limit === undefined ? "all" : String(limit.length);
};

/** The `plugin list` table: one plugin per row, in catalog order. */
export function formatPluginTable(plugins: PluginView[]): string[] {
  const rows = plugins.map(plugin => [
    plugin.id,
    plugin.manifest?.name ?? "-",
    plugin.manifest?.category ?? "-",
    plugin.installation?.installedVersion && plugin.manifest && plugin.installation.installedVersion !== plugin.manifest.version
      ? `${plugin.installation.installedVersion} → ${plugin.manifest.version}`
      : plugin.manifest?.version ?? plugin.installation?.installedVersion ?? "-",
    pluginStateLabel(plugin),
    repositories(plugin),
  ]);
  const header = ["ID", "NAME", "CATEGORY", "VERSION", "STATE", "REPOSITORIES"];
  const widths = header.map((title, column) => Math.max(title.length, ...rows.map(row => row[column].length)));
  const line = (cells: string[]) => cells.map((value, column) => (column === cells.length - 1 ? value : value.padEnd(widths[column]))).join("  ");
  return [line(header), ...rows.map(line)];
}

const list = (values: readonly string[]): string => (values.length ? values.join(", ") : "(none)");

/** The `plugin show` text: what the plugin is, what it needs and contributes, and its installation. */
export function formatPluginDetail(plugin: PluginDetail): string[] {
  const { manifest, installation } = plugin;
  const lines = [`${manifest?.name ?? plugin.id} (${plugin.id})`];
  if (manifest) {
    lines.push(`  ${manifest.description}`, "");
    lines.push(`  Category:     ${manifest.category}`, `  Version:      ${manifest.version}`, `  Homepage:     ${manifest.homepage}`);
  } else {
    lines.push("  This plugin is installed but no longer part of this ProPR version: it can only be disabled or uninstalled.");
  }
  lines.push(`  State:        ${pluginStateLabel(plugin)}`);
  if (installation) {
    lines.push(`  Installed:    ${installation.installedVersion} by ${installation.installedBy} on ${new Date(installation.installedAt).toISOString()}`);
    lines.push(`  Repositories: ${installation.repositories === null ? "all" : list(installation.repositories)}`);
    lines.push(`  Granted:      ${list(installation.grantedPermissions)}`);
  }
  if (manifest) {
    lines.push("", "  Permissions:");
    for (const permission of manifest.permissions) lines.push(`    ${permission.name}: ${permission.description}`);
    if (!manifest.permissions.length) lines.push("    (none)");
  }
  if (plugin.pendingPermissions.length) lines.push(`  Waiting for approval: ${plugin.pendingPermissions.join(", ")}`);
  for (const pending of plugin.pendingAcknowledgements) lines.push(`  Waiting for acknowledgement: ${pending.server} (${pending.package}@${pending.version}) reads ${pending.secretEnv.join(", ")}`);
  if (plugin.connections.length) {
    lines.push("", "  Connections:");
    for (const connection of plugin.connections) {
      const by = connection.setBy ? ` (set by ${connection.setBy})` : "";
      lines.push(`    ${connection.name} [${connection.type}]: ${connection.state.replaceAll("_", " ")}${connection.required ? ", required" : ""}${by}`);
    }
  }
  if (manifest) {
    const { contributes } = manifest;
    lines.push("", "  Contributes:");
    lines.push(`    MCP servers:   ${list(contributes.mcpServers.map(server => `${server.name} (${server.kind}, ${server.capability})`))}`);
    lines.push(`    Skills:        ${list(contributes.skills)}`);
    lines.push(`    Templates:     ${list(contributes.automationTemplates)}`);
    lines.push(`    Commands:      ${list(contributes.commands.map(command => `/${command.name}`))}`);
    lines.push(`    Subscriptions: ${list(contributes.subscriptions)}`);
    lines.push(`    Webhooks:      ${list(contributes.webhooks.map(webhook => `${webhook.name} (${webhook.scheme})`))}`);
    lines.push(`    Outbound:      ${list([...manifest.outboundHosts, ...manifest.outboundHostsFromSettings.map(key => `host of setting ${key}`)])}`);
  }
  if (plugin.enableBlockers.length) {
    lines.push("", "  Cannot be enabled yet:");
    for (const blocker of plugin.enableBlockers) lines.push(`    - ${blocker}`);
  }
  return lines;
}

/** Injected in tests; the configured API client otherwise. */
export interface PluginCommandDeps { client?: ApiClient }

function reportError(error: unknown, id?: string): void {
  if (id !== undefined && error instanceof ApiError && error.status === 404) {
    console.error(`Error: No plugin ${id}. Run 'propr plugin list' to see the plugins of this ProPR.`);
    return;
  }
  presentApiError(error, { forbiddenMessage: FORBIDDEN, fallbackMessage: message => `Error reading plugins: ${message}` });
}

/** Run `propr plugin list`. Resolves to the exit code. */
export async function runPluginList(options: { json?: boolean }, deps: PluginCommandDeps = {}): Promise<number> {
  try {
    const plugins = await listPlugins({ client: deps.client });
    if (options.json) console.log(JSON.stringify(plugins, null, 2));
    else if (!plugins.length) console.log("This ProPR has no plugins.");
    else for (const line of formatPluginTable(plugins)) console.log(line);
    return 0;
  } catch (error) {
    reportError(error);
    return 1;
  }
}

/** Run `propr plugin show <id>`. Resolves to the exit code. */
export async function runPluginShow(id: string, options: { json?: boolean }, deps: PluginCommandDeps = {}): Promise<number> {
  try {
    const plugin = await getPlugin(id, { client: deps.client });
    if (options.json) console.log(JSON.stringify(plugin, null, 2));
    else for (const line of formatPluginDetail(plugin)) console.log(line);
    return 0;
  } catch (error) {
    reportError(error, id);
    return 1;
  }
}

export function createPluginCommand(): Command {
  const plugin = new Command("plugin")
    .description("List and inspect plugins (read-only; instance administrators)");

  plugin.command("list")
    .description("List the plugins of this ProPR with their installation state")
    .option("-j, --json", "Output JSON")
    .action(async (options: { json?: boolean }) => {
      const code = await runPluginList(options);
      if (code !== 0) process.exit(code);
    });

  plugin.command("show <id>")
    .description("Show one plugin: permissions, connections, contributions and installation")
    .option("-j, --json", "Output JSON")
    .action(async (id: string, options: { json?: boolean }) => {
      const code = await runPluginShow(id, options);
      if (code !== 0) process.exit(code);
    });

  plugin.addHelpText("after", `
Install, configure and enable plugins on the Plugins page of the web UI.

Examples:
  $ propr plugin list
  $ propr plugin show slack --json
`);
  return plugin;
}
