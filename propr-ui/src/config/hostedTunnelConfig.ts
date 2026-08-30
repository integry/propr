import {
  DEFAULT_PROPR_UI_ORIGIN,
  isCanonicalProprConnectHostname,
  isProprProxyUrl,
  MAX_PROPR_API_BASE_URL_LENGTH,
} from '@propr/shared';

export const HOSTED_TUNNEL_API_BASE_STORAGE_KEY = 'propr.hostedTunnelApiBaseUrl';
export const HOSTED_TUNNEL_FLOW_ID_KEY = 'propr.hostedTunnelFlowId';
export const HOSTED_TUNNEL_CONTEXT_ID_KEY = 'propr.hostedTunnelContextId';

const WINDOW_NAME_CONTEXT_PREFIX = 'propr-hosted-flow-context:';
const WINDOW_NAME_CONTEXT_SEPARATOR = '|';
const MAX_HOSTED_QUERY_LENGTH = 4096;
const MAX_HOSTED_FLOW_ID_LENGTH = 128;
const HOSTED_UI_HOSTNAME = new URL(DEFAULT_PROPR_UI_ORIGIN).hostname;

export type HostedTunnelStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export const isHostedUiOrigin = (hostname: string): boolean => hostname === HOSTED_UI_HOSTNAME;

export const hostedTunnelQueryApiBaseUrl = (hostname: string, search: string): string | null => {
  if (!isHostedUiOrigin(hostname) || search.length > MAX_HOSTED_QUERY_LENGTH) return null;
  const query = search.startsWith('?') ? search.slice(1) : search;
  const rawValues = query.split('&').flatMap(parameter => {
    const separator = parameter.indexOf('=');
    const name = separator === -1 ? parameter : parameter.slice(0, separator);
    return name === 'tunnel' ? [separator === -1 ? '' : parameter.slice(separator + 1)] : [];
  });
  const decodedValues = new URLSearchParams(search).getAll('tunnel');
  if (rawValues.length !== 1 || decodedValues.length !== 1) return null;

  const rawComponent = rawValues[0];
  const value = decodedValues[0];
  if (!value || value.length > MAX_PROPR_API_BASE_URL_LENGTH || /[^\x21-\x7e]/.test(value)) return null;
  if (rawComponent !== value) return null;
  if (/^https:\/\//.test(value)) return isProprProxyUrl(value) ? value : null;
  if (!isCanonicalProprConnectHostname(value)) return null;
  return `https://${value}`;
};

export const hasHostedTunnelQueryParameter = (search: string): boolean => {
  if (search.length > MAX_HOSTED_QUERY_LENGTH) return true;
  return new URLSearchParams(search).has('tunnel');
};

export const storageForWindow = (): HostedTunnelStorage | undefined => {
  if (typeof window === 'undefined') return undefined;
  try { return window.sessionStorage; } catch { return undefined; }
};

const generateFlowId = (): string => {
  try { return crypto.randomUUID(); } catch { return Math.random().toString(36).slice(2) + Date.now().toString(36); }
};

const isValidHostedFlowToken = (value: string | null | undefined): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9-]{1,128}$/.test(value);

const contextIdFromWindowName = (name: string): string | null => {
  if (!name.startsWith(WINDOW_NAME_CONTEXT_PREFIX)) return null;
  const rest = name.slice(WINDOW_NAME_CONTEXT_PREFIX.length);
  const separatorIndex = rest.indexOf(WINDOW_NAME_CONTEXT_SEPARATOR);
  const contextId = separatorIndex === -1 ? rest : rest.slice(0, separatorIndex);
  return isValidHostedFlowToken(contextId) ? contextId : null;
};

const currentHostedTunnelContextId = (): string | null => {
  if (typeof window === 'undefined') return null;
  try { return contextIdFromWindowName(window.name); } catch { return null; }
};

const setHostedTunnelContextId = (contextId: string): string | null => {
  if (typeof window === 'undefined') return contextId;
  try {
    const existing = window.name || '';
    const separatorIndex = existing.indexOf(WINDOW_NAME_CONTEXT_SEPARATOR);
    const preservedName = existing.startsWith(WINDOW_NAME_CONTEXT_PREFIX)
      ? (separatorIndex === -1 ? '' : existing.slice(separatorIndex + 1))
      : existing;
    window.name = `${WINDOW_NAME_CONTEXT_PREFIX}${contextId}${WINDOW_NAME_CONTEXT_SEPARATOR}${preservedName}`;
    return contextId;
  } catch {
    return null;
  }
};

const ensureHostedTunnelContextId = (): string | null =>
  currentHostedTunnelContextId() || setHostedTunnelContextId(generateFlowId());

export const flowIdFromSearch = (search: string): string | null => {
  if (search.length > MAX_HOSTED_QUERY_LENGTH) return null;
  const value = new URLSearchParams(search).get('flow');
  return isValidHostedFlowToken(value) ? value : null;
};

export const rememberHostedTunnelApiBaseUrl = (
  hostname: string,
  apiBaseUrl: string,
  storage: HostedTunnelStorage | undefined = storageForWindow(),
  contextId: string | null = ensureHostedTunnelContextId(),
): string | null => {
  if (!isHostedUiOrigin(hostname) || !storage || !contextId || !isValidHostedFlowToken(contextId)) return null;
  if (apiBaseUrl.length > MAX_PROPR_API_BASE_URL_LENGTH || !isProprProxyUrl(apiBaseUrl)) return null;
  try {
    const flowId = generateFlowId();
    storage.setItem(HOSTED_TUNNEL_API_BASE_STORAGE_KEY, apiBaseUrl);
    storage.setItem(HOSTED_TUNNEL_FLOW_ID_KEY, flowId);
    storage.setItem(HOSTED_TUNNEL_CONTEXT_ID_KEY, contextId);
    return flowId;
  } catch {
    return null;
  }
};

interface StoredFlowBinding {
  flowId: string;
  contextId: string;
}

const readStoredFlowBinding = (storage: HostedTunnelStorage): StoredFlowBinding | null => {
  const flowId = storage.getItem(HOSTED_TUNNEL_FLOW_ID_KEY);
  const contextId = storage.getItem(HOSTED_TUNNEL_CONTEXT_ID_KEY);
  if ((flowId?.length ?? 0) > MAX_HOSTED_FLOW_ID_LENGTH) return null;
  if ((contextId?.length ?? 0) > MAX_HOSTED_FLOW_ID_LENGTH) return null;
  if (!isValidHostedFlowToken(flowId) || !isValidHostedFlowToken(contextId)) return null;
  return { flowId, contextId };
};

const currentContextMatches = (storedContextId: string, contextId: string | null | undefined): boolean => {
  const currentContextId = contextId === undefined ? currentHostedTunnelContextId() : contextId;
  return Boolean(currentContextId && currentContextId === storedContextId);
};

const readCanonicalStoredEndpoint = (storage: HostedTunnelStorage): string | null => {
  const stored = storage.getItem(HOSTED_TUNNEL_API_BASE_STORAGE_KEY);
  if ((stored?.length ?? 0) > MAX_PROPR_API_BASE_URL_LENGTH || stored !== stored?.trim()) {
    storage.removeItem(HOSTED_TUNNEL_API_BASE_STORAGE_KEY);
    return null;
  }
  if (stored && isProprProxyUrl(stored)) return stored;
  if (stored) storage.removeItem(HOSTED_TUNNEL_API_BASE_STORAGE_KEY);
  return null;
};

export const readStoredHostedTunnelApiBaseUrl = (
  hostname: string,
  flowId: string | null,
  storage: HostedTunnelStorage | undefined = storageForWindow(),
  contextId?: string | null,
): string | null => {
  if (!isHostedUiOrigin(hostname) || !storage) return null;
  try {
    const binding = readStoredFlowBinding(storage);
    if (!binding || binding.flowId !== flowId) return null;
    if (!currentContextMatches(binding.contextId, contextId)) return null;
    return readCanonicalStoredEndpoint(storage);
  } catch {
    return null;
  }
};
