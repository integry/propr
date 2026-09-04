import { io, type ManagerOptions, type Socket, type SocketOptions } from 'socket.io-client';
import type { ProprApiBaseUrl } from './baseUrl.js';

export type AccessTokenProvider = () => string | null | undefined | Promise<string | null | undefined>;

export type ProprAuthentication =
  | {
      type: 'session';
      credentials?: RequestCredentials;
      /** Leave RequestInit credentials untouched unless a request opts in. */
      applyByDefault?: boolean;
    }
  | { type: 'bearer'; getAccessToken: AccessTokenProvider }
  | { type: 'none' };

export type ProprSocketOptions = Partial<ManagerOptions & SocketOptions>;

export interface ProprSocketConnection {
  url: string | undefined;
  options: ProprSocketOptions;
}

type SocketAuthPayload = Record<string, unknown>;
type SocketAuthCallback = (data: SocketAuthPayload) => void;

const metadataWithoutToken = (value: unknown): SocketAuthPayload => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const { token: _untrustedToken, ...metadata } = value as SocketAuthPayload;
  return metadata;
};

const bearerSocketAuth = (
  getAccessToken: AccessTokenProvider,
  configuredAuth: SocketOptions['auth'],
): SocketOptions['auth'] => (callback: SocketAuthCallback): void => {
  const resolveBearer = (metadataValue: unknown): void => {
    const metadata = metadataWithoutToken(metadataValue);
    Promise.resolve(getAccessToken()).then(
      token => {
        const normalized = token?.trim();
        callback(normalized && !/\r|\n/.test(normalized)
          ? { ...metadata, token: normalized }
          : metadata);
      },
      () => callback(metadata),
    );
  };

  if (typeof configuredAuth === 'function') {
    try {
      configuredAuth(resolveBearer);
    } catch {
      resolveBearer({});
    }
    return;
  }
  resolveBearer(configuredAuth);
};

/** Build the complete, explicit reconnect policy used by every ProPR surface. */
export const buildSocketConnection = (
  baseUrl: ProprApiBaseUrl,
  authentication: ProprAuthentication,
  overrides: ProprSocketOptions = {}
): ProprSocketConnection => {
  const auth = authentication.type === 'bearer'
    ? bearerSocketAuth(authentication.getAccessToken, overrides.auth)
    : undefined;

  return {
    url: baseUrl || undefined,
    options: {
      transports: ['websocket'],
      withCredentials: authentication.type === 'session',
      autoConnect: true,
      path: '/socket.io/',
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      randomizationFactor: 0.5,
      timeout: 20_000,
      ...overrides,
      ...(auth ? { auth } : {}),
    },
  };
};

export const connectProprSocket = (
  connection: ProprSocketConnection
): Socket => io(connection.url, connection.options);

export type { Socket } from 'socket.io-client';
