import type { ProprApi } from '@propr/client';
import { PLUGIN_API_BASE } from '@propr/shared';
import { API_BASE_URL, apiFetch } from './apiClient';

/**
 * Client of the plugin installation routes (`/api/instance/plugins/v1`),
 * typed from the generated OpenAPI types. Every route needs a current durable
 * administrator with `instance.manage_settings`; mutations send JSON with the
 * `X-ProPR-Plugins: 1` preflight header. Connection secrets are write-only:
 * they are sent, never read back.
 */
export type PluginView = ProprApi.PluginView;
export type PluginDetailView = ProprApi.PluginDetailResponse['plugin'];
export type PluginManifestView = NonNullable<PluginView['manifest']>;
export type PluginConnectionView = PluginView['connections'][number];

/** The refusal text the API returned, kept so the page can show it verbatim. */
export class PluginApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = 'PluginApiError'; }
}

async function request<T>(path: string, init?: { method: 'POST' | 'PUT'; body: unknown }): Promise<T> {
  const response = await apiFetch(`${API_BASE_URL}${PLUGIN_API_BASE}${path}`, {
    credentials: 'include', cache: 'no-store',
    ...(init ? { method: init.method, headers: { 'Content-Type': 'application/json', 'X-ProPR-Plugins': '1' }, body: JSON.stringify(init.body) } : {}),
  });
  if (response.ok) return response.json() as Promise<T>;
  const failure = await response.json().catch(() => null) as { code?: string; message?: string; error?: string } | null;
  // The read-only demo explains why plugins are not shown.
  if (response.status === 403 && failure?.code === 'DEMO_MODE_LIVE_DATA_UNAVAILABLE' && failure.message) throw new PluginApiError(403, failure.message);
  if (typeof failure?.error === 'string' && failure.error) throw new PluginApiError(response.status, failure.error);
  if (response.status === 403) throw new PluginApiError(403, 'A current durable instance administrator is required.');
  throw new PluginApiError(response.status, 'Plugin operation unavailable. Check the configuration and try again.');
}

const segment = (value: string) => `/${encodeURIComponent(value)}`;
const plugin = (id: string, rest = '') => `${segment(id)}${rest}`;
const connection = (id: string, name: string, rest = '') => plugin(id, `/connections${segment(name)}${rest}`);
type Plugin = Promise<ProprApi.PluginResponse>;

export const listPlugins = () => request<ProprApi.PluginList>('');
export const getPlugin = (id: string) => request<ProprApi.PluginDetailResponse>(plugin(id));
/** `acknowledgements` names the package servers whose secret variables the administrator confirmed are readable in the task container. */
export const installPlugin = (id: string, acknowledgements: string[]): Plugin =>
  request(plugin(id, '/install'), { method: 'POST', body: acknowledgements.length ? { acknowledgements } : {} });
/** Approve permissions and acknowledgements a newer manifest asks for. */
export const approvePlugin = (id: string, acknowledgements: string[]): Plugin =>
  request(plugin(id, '/approve'), { method: 'POST', body: acknowledgements.length ? { acknowledgements } : {} });
/** `null` (or an empty list) for all repositories. */
export const setPluginRepositories = (id: string, repositories: string[] | null): Plugin =>
  request(plugin(id, '/repositories'), { method: 'PUT', body: { repositories: repositories?.length ? repositories : null } satisfies ProprApi.PluginRepositoriesRequest });
export const setPluginEnabled = (id: string, enabled: boolean): Plugin =>
  request(plugin(id, '/enabled'), { method: 'PUT', body: { enabled } satisfies ProprApi.PluginEnabledRequest });
/** Set (`value`) or clear (`null`) a `token` or `signing_secret` connection. */
export const setPluginConnection = (id: string, name: string, value: string | null): Plugin =>
  request(connection(id, name), { method: 'PUT', body: { value } });
/** The uninstall must repeat the plugin id. */
export const uninstallPlugin = (id: string): Plugin =>
  request(plugin(id, '/uninstall'), { method: 'POST', body: { confirm: id } satisfies ProprApi.PluginUninstallRequest });
export const startPluginOAuth = (id: string, name: string) =>
  request<ProprApi.PluginOAuthStartResponse>(connection(id, name, '/oauth/start'), { method: 'POST', body: {} });
export const disconnectPluginOAuth = (id: string, name: string): Plugin =>
  request(connection(id, name, '/oauth/disconnect'), { method: 'POST', body: {} });
