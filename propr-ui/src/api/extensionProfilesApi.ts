import type {
  ExtensionCatalogEntry, ExtensionLibraryInput, ExtensionLibraryRevision, ExtensionLibraryUsage, ExtensionOAuthCheckResult, ExtensionOAuthInstanceInfo, ExtensionSkillBundle,
} from '@propr/shared';
import { API_BASE_URL, apiFetch } from './apiClient';
async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await apiFetch(`${API_BASE_URL}/api/instance/extensions/v1${path}`, {
    credentials: 'include', cache: 'no-store',
    ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-ProPR-Extensions': '1' }, body: JSON.stringify(body) }),
  });
  if (response.ok) return response.json();
  const failure = await response.json().catch(() => null) as { code?: string; message?: string; error?: string } | null;
  // The read-only demo explains why the extension library is not shown.
  if (response.status === 403 && failure?.code === 'DEMO_MODE_LIVE_DATA_UNAVAILABLE' && failure.message) throw new Error(failure.message);
  if (response.status === 403) throw new Error('A current durable instance administrator is required.');
  // Conflicts and validation errors name what to fix, such as the automations that add an item.
  if ([400, 404, 409].includes(response.status) && typeof failure?.error === 'string' && failure.error) throw new Error(failure.error);
  if (response.status === 409) throw new Error('The extension library changed. Refresh and try again.');
  throw new Error('Extension operation unavailable. Check the configuration and try again.');
}
export type ExtensionItemRef = { kind: 'server'; name: string } | { kind: 'skill'; bundleId: string };
export interface ExtensionLibraryResponse {
  instanceId: string;
  library: ExtensionLibraryRevision;
  bundles?: ExtensionSkillBundle[];
  catalog?: ExtensionCatalogEntry[];
  /** Automations that add items explicitly, and profiles migrated items came from. */
  usage?: ExtensionLibraryUsage;
  /** OAuth redirect URI of this instance and the connection state of OAuth servers; never tokens. */
  oauth?: ExtensionOAuthInstanceInfo;
}
export type ExtensionValidationResult = { name: string; reachable: boolean | null; status?: 'reachable' | 'unavailable' | 'not_validated' };
export const getExtensionLibrary = () => request<ExtensionLibraryResponse>('');
export const saveExtensionLibrary = (input: ExtensionLibraryInput, expectedRevision: number, secrets: Record<string, string | null> = {}) =>
  request<{ library: ExtensionLibraryRevision }>('/library', { input, expectedRevision, secrets });
/** Switch one saved item on or off in its own revision, keeping its settings and stored secret. */
export const setExtensionItemEnabled = (item: ExtensionItemRef, enabled: boolean) =>
  request<{ library: ExtensionLibraryRevision }>('/items/enabled', { item, enabled });
export const replaceExtensionSecret = (name: string, secret: string | null, expectedRevision?: number) =>
  request<{ library: ExtensionLibraryRevision }>('/secrets', { name, secret, ...(expectedRevision === undefined ? {} : { expectedRevision }) });
export const extensionLibraryHistory = () => request<{ revisions: ExtensionLibraryRevision[] }>('/history');
export const validateExtensionLibrary = () => request<{ results: ExtensionValidationResult[] }>('/validate', {});
export const importGithubSkill = (repository: string, commit: string, directory: string) => request<{ bundle: ExtensionSkillBundle }>('/skills/github', { repository, commit, directory });
export async function importArchiveSkill(file: File): Promise<{ bundle: ExtensionSkillBundle }> {
  if (file.size > 5 * 1024 * 1024) throw new Error('Skill archives must be at most 5 MiB.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  let encoded = ''; for (let i = 0; i < bytes.length; i += 8192) encoded += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return request('/skills/archive', { filename: file.name, archive: btoa(encoded) });
}

export const discoverExtensionTools = (url: string) => request<{ tools: string[] }>('/tools/discover', { url });
export type GithubSkillRef = { name: string; ref: string; kind: 'branch' | 'tag' };
export const listGithubSkillRefs = (repository: string) => request<{ refs: GithubSkillRef[] }>('/skills/github-source', { repository });
export const resolveGithubSkillRef = (repository: string, ref: string) => request<{ commit: string }>('/skills/github-source', { repository, ref });

/** Run OAuth discovery for a server URL; stores nothing and sends no credential. */
export const checkExtensionOAuth = (url: string, options: { clientId?: string; scopes?: string[] } = {}) =>
  request<{ check: ExtensionOAuthCheckResult }>('/oauth/check', { url, ...(options.clientId ? { clientId: options.clientId } : {}), ...(options.scopes?.length ? { scopes: options.scopes } : {}) });
/** Start a sign-in bound to this browser session; returns the provider's authorization page. */
export const startExtensionOAuth = (name: string) => request<{ authorizationUrl: string }>('/oauth/start', { name });
/** Revoke at the provider when supported, then delete the stored tokens. */
export const disconnectExtensionOAuth = (name: string) => request<{ revoked: boolean }>('/oauth/disconnect', { name });
