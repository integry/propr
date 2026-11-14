import {
  missingRequiredPluginSettings, pluginPackageSecretServers, publicPluginManifest, requiredPluginConnections,
  type PluginConnectionStatus, type PluginInstallationRecord, type PluginManifest, type PluginPendingAcknowledgement, type PluginPermission,
  type PluginSecretAcknowledgement, type PluginSettingValues, type PluginView,
} from '@propr/shared';

export class PluginError extends Error { constructor(readonly status: number, message: string) { super(message); } }

/** A `plugin_installations` row as stored. */
export interface PluginInstallationRow {
  plugin_id: string; manifest_version: string; enabled: number | boolean; settings: string; repositories: string | null;
  granted_permissions: string; acknowledgements: string;
  installed_by: string; installed_at: number | string; updated_by: string; updated_at: number | string;
}
export interface PluginSecretRow { plugin_id: string; connection_name: string; set_by: string; set_at: number | string }

const json = <T>(value: string | null, fallback: T): T => {
  if (value === null) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
};
export function installationRecord(row: PluginInstallationRow): PluginInstallationRecord {
  return {
    installedVersion: row.manifest_version, enabled: Boolean(row.enabled),
    settings: json<PluginSettingValues>(row.settings, {}), repositories: json<string[] | null>(row.repositories, null),
    grantedPermissions: json<PluginPermission[]>(row.granted_permissions, []),
    acknowledgements: json<Record<string, PluginSecretAcknowledgement>>(row.acknowledgements, {}),
    installedBy: row.installed_by, installedAt: Number(row.installed_at), updatedBy: row.updated_by, updatedAt: Number(row.updated_at),
  };
}

const binding = (value: { package: string; version: string; secretEnv: string[] }) => JSON.stringify([value.package, value.version, [...value.secretEnv].sort()]);
const secretNames = (server: ReturnType<typeof pluginPackageSecretServers>[number]) => server.secretEnv.map(secret => secret.name);

/** Package servers whose secret variables have no acknowledgement for their current package, version and variable names. */
export function pendingAcknowledgements(manifest: PluginManifest, acknowledgements: Record<string, PluginSecretAcknowledgement>): PluginPendingAcknowledgement[] {
  return pluginPackageSecretServers(manifest).flatMap(server => {
    const current = { package: server.package, version: server.version, secretEnv: secretNames(server) };
    const recorded = Object.hasOwn(acknowledgements, server.name) ? acknowledgements[server.name] : undefined;
    return recorded && binding(recorded) === binding(current) ? [] : [{ server: server.name, ...current }];
  });
}

/**
 * The acknowledgements to record: those still matching the manifest are kept,
 * every pending one must be named in `acknowledged`. Acknowledgements of
 * servers the manifest no longer has are dropped.
 */
// eslint-disable-next-line max-params -- the manifest, recorded acknowledgements, names acknowledged now, actor and time are explicit inputs
export function nextAcknowledgements(manifest: PluginManifest, recorded: Record<string, PluginSecretAcknowledgement>, acknowledged: string[], actor: string, now: number): Record<string, PluginSecretAcknowledgement> {
  const pending = pendingAcknowledgements(manifest, recorded);
  const missing = pending.filter(item => !acknowledged.includes(item.server));
  if (missing.length) throw new PluginError(400, `Confirm that the secret variables of ${missing.map(m => m.server).join(', ')} are readable by the agent CLI, its shell tools and repository setup scripts in the task container`);
  const result: Record<string, PluginSecretAcknowledgement> = {};
  for (const server of pluginPackageSecretServers(manifest)) {
    const item = pending.find(p => p.server === server.name);
    result[server.name] = item ? { actor, at: now, package: item.package, version: item.version, secretEnv: item.secretEnv } : recorded[server.name];
  }
  return result;
}

/** Validate the server names an install or approval acknowledges. */
export function parseAcknowledgements(value: unknown, manifest: PluginManifest): string[] {
  if (value === undefined) return [];
  const names = pluginPackageSecretServers(manifest).map(s => s.name);
  if (!Array.isArray(value) || value.length > names.length || value.some(name => typeof name !== 'string' || !names.includes(name))) throw new PluginError(400, 'Invalid secret acknowledgement');
  return [...new Set(value as string[])];
}

export function pendingPermissions(manifest: PluginManifest, granted: readonly string[]): PluginPermission[] {
  return manifest.permissions.filter(permission => !granted.includes(permission));
}

export function connectionStatuses(manifest: PluginManifest, secrets: readonly PluginSecretRow[]): PluginConnectionStatus[] {
  const required = requiredPluginConnections(manifest);
  return manifest.connections.map(connection => {
    const row = connection.type === 'oauth' ? undefined : secrets.find(s => s.connection_name === connection.name);
    return {
      name: connection.name, type: connection.type, label: connection.label, required: required.includes(connection.name),
      state: row ? 'connected' : 'not_connected', ...(row ? { setBy: row.set_by, setAt: Number(row.set_at) } : {}),
    };
  });
}

/** Why the plugin cannot be enabled now. Pending permissions do not block: the plugin keeps its old grant. */
export function enableBlockers(manifest: PluginManifest | null, record: PluginInstallationRecord, secrets: readonly PluginSecretRow[]): string[] {
  if (!manifest) return ['The plugin is no longer in this ProPR version\'s registry'];
  const blockers: string[] = [];
  for (const key of missingRequiredPluginSettings(manifest.settings, record.settings)) blockers.push(`Required setting ${manifest.settings.properties[key]?.label ?? key} (${key}) is missing`);
  for (const status of connectionStatuses(manifest, secrets)) {
    if (status.required && status.state !== 'connected') blockers.push(`Connection ${status.label} (${status.name}) is not set`);
  }
  for (const item of pendingAcknowledgements(manifest, record.acknowledgements)) blockers.push(`The secret variables of package server ${item.server} (${item.secretEnv.join(', ')}) need an administrator acknowledgement`);
  return blockers;
}

/** The state view of one plugin; never a secret. */
export function pluginView(id: string, manifest: PluginManifest | null, row: PluginInstallationRow | undefined, secrets: readonly PluginSecretRow[]): PluginView {
  const installation = row ? installationRecord(row) : null;
  const permissions = manifest && installation ? pendingPermissions(manifest, installation.grantedPermissions) : [];
  const acknowledgements = manifest && installation ? pendingAcknowledgements(manifest, installation.acknowledgements) : [];
  const blockers = installation ? enableBlockers(manifest, installation, secrets) : [];
  return {
    id, available: Boolean(manifest), manifest: manifest ? publicPluginManifest(manifest) : null,
    state: !installation ? 'available' : installation.enabled ? 'enabled' : 'installed',
    installation,
    connections: manifest ? (installation ? connectionStatuses(manifest, secrets) : connectionStatuses(manifest, [])) : [],
    needsApproval: permissions.length > 0 || acknowledgements.length > 0,
    pendingPermissions: permissions, pendingAcknowledgements: acknowledgements,
    enableBlockers: blockers,
  };
}
