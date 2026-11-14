import type { PluginConnectionType, PluginManifest, PluginPermission, PluginSetting, PluginSettings, PublicPluginManifest } from './plugins.js';

/**
 * Installation state of a plugin on one ProPR instance: whether an
 * administrator installed it, whether it is enabled, its settings, the
 * repositories it is limited to, the permissions granted and the secret
 * acknowledgements of its package servers. Connection secrets are write-only
 * and never part of anything here; only their state is.
 */
export const PLUGIN_API_BASE = '/api/instance/plugins/v1' as const;
export const PLUGIN_REPOSITORY_LIMIT = 256;
export const PLUGIN_SECRET_PATTERN = /^[\x21-\x7e]{1,4096}$/;
export const PLUGIN_REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export type PluginSettingValue = string | number | boolean | string[] | Record<string, string>;
export type PluginSettingValues = Record<string, PluginSettingValue>;

/**
 * `connected` once a token or signing secret is stored. An `oauth` connection
 * is `connected` once every managed server that uses it is signed in through
 * the extension OAuth sign-in, and `needs_sign_in` when a refresh failed.
 */
export type PluginConnectionState = 'connected' | 'not_connected' | 'needs_sign_in';
export interface PluginConnectionStatus {
  name: string; type: PluginConnectionType; label: string;
  state: PluginConnectionState;
  /** A `token` connection a contributed MCP server uses; enabling waits for it. */
  required: boolean;
  /** Who set the value and when; for an `oauth` connection, who configured its pre-registered client. */
  setBy?: string; setAt?: number;
}

/** The extension library route that lists and edits managed items. */
export const PLUGIN_LIBRARY_HREF = '/api/instance/extensions/v1' as const;
/** The automation template catalog route. */
export const PLUGIN_TEMPLATE_CATALOG_HREF = '/api/automation-definitions/templates' as const;
/**
 * What an installed plugin added: its managed library items (with their
 * library reference) and its automation templates. `active` is true while
 * the item can apply to runs as far as the plugin is concerned (the plugin is
 * enabled and nothing awaits an acknowledgement); the item's own enabled
 * switch and limits still apply.
 */
export interface PluginContributionViews {
  mcpServers: { name: string; kind: 'https' | 'package'; managed: { kind: 'server'; name: string; enabled: boolean; active: boolean } | null; href: string }[];
  skills: { name: string; managed: { kind: 'skill'; bundleId: string; enabled: boolean; active: boolean } | null; href: string }[];
  automationTemplates: { id: string; catalogId: string; available: boolean; href: string }[];
}

/** The administrator's acknowledgement that a package server's secret variables are readable inside the task container. */
export interface PluginSecretAcknowledgement { actor: string; at: number; package: string; version: string; secretEnv: string[] }
/** A package server whose secret variables need (again) an acknowledgement. */
export interface PluginPendingAcknowledgement { server: string; package: string; version: string; secretEnv: string[] }

export type PluginInstallationState = 'available' | 'installed' | 'enabled';
export interface PluginInstallationRecord {
  /** The manifest version the administrator installed or last approved. */
  installedVersion: string;
  enabled: boolean;
  settings: PluginSettingValues;
  /** Repositories (`owner/repo`) the plugin is limited to; `null` for all repositories. */
  repositories: string[] | null;
  grantedPermissions: PluginPermission[];
  acknowledgements: Record<string, PluginSecretAcknowledgement>;
  installedBy: string; installedAt: number; updatedBy: string; updatedAt: number;
}
export interface PluginView {
  id: string;
  /** The plugin is in this ProPR's registry. An installed plugin removed by an upgrade can only be disabled or uninstalled. */
  available: boolean;
  manifest: PublicPluginManifest | null;
  state: PluginInstallationState;
  installation: PluginInstallationRecord | null;
  connections: PluginConnectionStatus[];
  /** The current manifest asks for permissions that were not granted: the plugin keeps its old grant until approved. */
  needsApproval: boolean;
  pendingPermissions: PluginPermission[];
  pendingAcknowledgements: PluginPendingAcknowledgement[];
  /** Why enabling is refused right now; empty when the plugin can be enabled. */
  enableBlockers: string[];
  /** Managed library items and templates; items are null until the plugin is installed. */
  contributions?: PluginContributionViews;
}
export interface PluginAuditEvent { action: PluginAuditAction; actor: string; at: number; detail: Record<string, unknown> }
export const PLUGIN_AUDIT_ACTIONS = ['install', 'update_settings', 'set_repositories', 'set_connection', 'clear_connection', 'enable', 'disable', 'approve', 'uninstall', 'start_oauth', 'complete_oauth', 'disconnect_oauth', 'set_oauth_client', 'clear_oauth_client'] as const;
export type PluginAuditAction = typeof PLUGIN_AUDIT_ACTIONS[number];
export interface PluginDetail extends PluginView { audit: PluginAuditEvent[] }

/** The package servers of a manifest that hand secret variables to the task container. */
export function pluginPackageSecretServers(manifest: PluginManifest) {
  return manifest.contributes.mcpServers.flatMap(server => (server.kind === 'package' && server.secretEnv.length ? [server] : []));
}
/** `token` connections a contributed MCP server needs: a bearer server's connection or a package server's secret variable. */
export function requiredPluginConnections(manifest: PluginManifest): string[] {
  const names = new Set<string>();
  for (const server of manifest.contributes.mcpServers) {
    if (server.kind === 'https' && server.authentication === 'bearer' && server.connection) names.add(server.connection);
    if (server.kind === 'package') for (const secret of server.secretEnv) names.add(secret.connection);
  }
  return manifest.connections.filter(c => c.type === 'token' && names.has(c.name)).map(c => c.name);
}

/** The settings a fresh installation starts with: every default the manifest declares. */
export function defaultPluginSettings(settings: PluginSettings): PluginSettingValues {
  const values: PluginSettingValues = {};
  for (const [key, setting] of Object.entries(settings.properties)) {
    if (setting.default !== undefined) values[key] = structuredClone(setting.default) as PluginSettingValue;
  }
  return values;
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function stringProblem(key: string, setting: Extract<PluginSetting, { type: 'string' }>, value: unknown): string | null {
  if (typeof value !== 'string') return `${key} must be text`;
  if (value.length > (setting.maxLength ?? 500)) return `${key} is longer than ${setting.maxLength ?? 500} characters`;
  if (setting.enum && !setting.enum.includes(value)) return `${key} must be one of ${setting.enum.join(', ')}`;
  return null;
}
function numberProblem(key: string, setting: Extract<PluginSetting, { type: 'number' }>, value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return `${key} must be a number`;
  if (setting.integer && !Number.isInteger(value)) return `${key} must be a whole number`;
  if (setting.minimum !== undefined && value < setting.minimum) return `${key} must be at least ${setting.minimum}`;
  if (setting.maximum !== undefined && value > setting.maximum) return `${key} must be at most ${setting.maximum}`;
  return null;
}
function arrayProblem(key: string, setting: Extract<PluginSetting, { type: 'array' }>, value: unknown): string | null {
  const max = setting.maxItems ?? 256;
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.length > 500)) return `${key} must be a list of text values`;
  return value.length > max ? `${key} has more than ${max} entries` : null;
}
function repositoryMapProblem(key: string, value: unknown): string | null {
  if (!isRecord(value)) return `${key} must map owner/repo to text`;
  const entries = Object.entries(value);
  if (entries.length > 256) return `${key} has more than 256 entries`;
  if (entries.some(([repository, text]) => !PLUGIN_REPOSITORY_PATTERN.test(repository) || typeof text !== 'string' || text.length > 500)) return `${key} must map owner/repo to text`;
  return null;
}
/** Why one value does not fit its setting, or null. */
export function pluginSettingProblem(key: string, setting: PluginSetting, value: unknown): string | null {
  switch (setting.type) {
    case 'string': return stringProblem(key, setting, value);
    case 'number': return numberProblem(key, setting, value);
    case 'boolean': return typeof value === 'boolean' ? null : `${key} must be true or false`;
    case 'array': return arrayProblem(key, setting, value);
    case 'object': return repositoryMapProblem(key, value);
  }
}

/**
 * Validate a complete settings object against a manifest's settings schema.
 * Unknown keys are refused; a missing required setting is not an error here
 * (see `missingRequiredPluginSettings`), it only blocks enabling.
 */
export function validatePluginSettings(settings: PluginSettings, value: unknown): { ok: true; settings: PluginSettingValues } | { ok: false; errors: string[] } {
  if (!isRecord(value)) return { ok: false, errors: ['Settings must be an object'] };
  const errors: string[] = [];
  for (const [key, item] of Object.entries(value)) {
    const setting = Object.hasOwn(settings.properties, key) ? settings.properties[key] : undefined;
    if (!setting) { errors.push(`${key} is not a setting of this plugin`); continue; }
    if (item === null || item === undefined) continue;
    const problem = pluginSettingProblem(key, setting, item);
    if (problem) errors.push(problem);
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, settings: Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null && item !== undefined)) as PluginSettingValues };
}

/** Required settings that have no value (an empty text counts as missing). */
export function missingRequiredPluginSettings(settings: PluginSettings, values: PluginSettingValues): string[] {
  return settings.required.filter(key => !Object.hasOwn(values, key) || values[key] === '');
}
