export {
  apiUrl,
  normalizeApiBaseUrl,
  type NormalizeApiBaseUrlOptions,
  type ProprApiBaseUrl,
} from './baseUrl.js';
export {
  ProprClient,
  type ProprClientOptions,
  type ProprCompatibilityOptions,
  type ProprFetchOptions,
  type ProprRequestOptions,
} from './client.js';
export {
  isProprClientError,
  ProprClientError,
  type ProprClientErrorKind,
  type ProprClientErrorOptions,
} from './errors.js';
export {
  completeDesktopPairing,
  parseDesktopDiscovery,
  parseDesktopPairingStart,
  type ProprDesktopDiscovery,
  type ProprDesktopPairingComplete,
  type ProprDesktopPairingOptions,
  type ProprDesktopPairingStart,
} from './desktopPairing.js';
export {
  normalizeInstanceProfile,
  type NormalizedProprInstanceProfile,
  type ProprInstanceAuthentication,
  type ProprInstanceProfile,
} from './profile.js';
export {
  buildSocketConnection,
  connectProprSocket,
  type AccessTokenProvider,
  type ProprAuthentication,
  type ProprSocketConnection,
  type ProprSocketOptions,
  type Socket,
} from './socket.js';
