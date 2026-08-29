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

const bearerSocketAuth = (getAccessToken: AccessTokenProvider): SocketOptions['auth'] =>
  (callback: (data: Record<string, string>) => void): void => {
    Promise.resolve(getAccessToken()).then(
      token => {
        const normalized = token?.trim();
        callback(normalized && !/\r|\n/.test(normalized) ? { token: normalized } : {});
      },
      () => callback({})
    );
  };

/** Build the complete, explicit reconnect policy used by every ProPR surface. */
export const buildSocketConnection = (
  baseUrl: ProprApiBaseUrl,
  authentication: ProprAuthentication,
  overrides: ProprSocketOptions = {}
): ProprSocketConnection => {
  const auth = authentication.type === 'bearer'
    ? bearerSocketAuth(authentication.getAccessToken)
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
      ...(auth && overrides.auth === undefined ? { auth } : {}),
    },
  };
};

export const connectProprSocket = (
  connection: ProprSocketConnection
): Socket => io(connection.url, connection.options);

export type { Socket } from 'socket.io-client';
