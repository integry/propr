export {
  apiUrl,
  classifyApiBaseUrl,
  normalizeApiBaseUrl,
  type NormalizeApiBaseUrlOptions,
  type ProprApiEndpointClassification,
  type ProprApiEndpointKind,
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
  DESKTOP_DISCOVERY_AUTHENTICATION_REQUIRED,
  isProprClientError,
  ProprClientError,
  type ProprClientErrorKind,
  type ProprClientErrorOptions,
} from './errors.js';
export {
  completeDesktopPairing,
  parseDesktopDiscovery,
  parseDesktopPairingStart,
  parseDesktopPairingActivationReceipt,
  type ProprDesktopPairingActivationReceipt,
  type ProprDesktopPairingBinding,
  type ProprDesktopDiscovery,
  type ProprDesktopPairingComplete,
  type ProprDesktopPairingOptions,
  type ProprDesktopPairingStart,
} from './desktopPairing.js';
export type { PairingProtocolRequestOptions } from './pairingProtocol.js';
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
