import type { Socket } from '@propr/client';
import { DESKTOP_TRANSPORT_SCOPE_QUERY } from '@propr/shared';
import {
  apiFetch,
  getDesktopConnectionScope,
  handleDesktopAccessCode,
  proprClient,
} from '../api/apiClient';
import { getCurrentUser } from '../api/proprApi';
import { createElectronDesktopAdapters } from './electronAdapters';
import type { DesktopRendererBridge } from '../../../apps/desktop/src/shared/contract';
import type { DesktopProfile } from './types';

interface SocketRecord {
  socket: Socket;
  profileId: string;
  transportScope: string;
}

interface PackagedTransportSmokeHarness {
  activate(profile: DesktopProfile): Promise<{
    profileId: string;
    transportScope: string;
    identityEpoch: string;
    contractsContainSecret: boolean;
  }>;
  rest(): Promise<void>;
  connectSocket(): Promise<number>;
  reconnectSocket(id: number): Promise<void>;
  expectSocketRejected(id: number): Promise<{
    transportRejected: true;
    freshManagerConnected: true;
  }>;
  disconnectSocket(id: number): void;
  handleStaleInvalidation(profileId: string, transportScope: string): Promise<string>;
  rendererEvidence(): unknown;
}

declare global {
  interface Window {
    __proprPackagedTransportSmoke?: PackagedTransportSmokeHarness;
  }
}

const rendererSocketOptions = (transportScope: string) => ({
  transports: ['websocket'] as ['websocket'],
  forceNew: true,
  reconnection: true,
  withCredentials: false,
  query: { [DESKTOP_TRANSPORT_SCOPE_QUERY]: transportScope },
});

/** Keep the rejected reconnect bound to the immutable scope recorded for that Manager. */
export const staleReconnectQuery = (
  recordedTransportScope: string,
  currentTransportScope: string,
): Record<string, string> => {
  if (recordedTransportScope === currentTransportScope) {
    throw new Error('Packaged stale Socket.IO activation was not rotated');
  }
  return { [DESKTOP_TRANSPORT_SCOPE_QUERY]: recordedTransportScope };
};

const waitForSocket = (socket: Socket, expected: 'connect' | 'connect_error'): Promise<void> =>
  new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error(`Packaged Socket.IO ${expected} timed out`));
    }, 5_000);
    const connected = () => {
      cleanup();
      if (expected === 'connect') resolve();
      else reject(new Error('Stale Socket.IO scope unexpectedly connected'));
    };
    const failed = () => {
      cleanup();
      if (expected !== 'connect_error') {
        reject(new Error('Packaged Socket.IO connection failed'));
      } else {
        resolve();
      }
    };
    const cleanup = () => {
      window.clearTimeout(timer);
      socket.off('connect', connected);
      socket.off('connect_error', failed);
    };
    socket.once('connect', connected);
    socket.once('connect_error', failed);
  });

/** Packaged-only E2E driver composed from the production renderer adapters. */
export const createPackagedTransportSmokeHarness = (
  bridge: DesktopRendererBridge,
): PackagedTransportSmokeHarness => {
  const adapters = createElectronDesktopAdapters(bridge);
  const sockets = new Map<number, SocketRecord>();
  let nextSocketId = 1;
  let nextCurrentUserScopeGeneration = 1;

  const harness: PackagedTransportSmokeHarness = {
    async activate(profile) {
      const probed = await adapters.connection.probe(profile);
      if (probed.status !== 'ready' || !adapters.connection.activate || !adapters.connection.publishActivation) {
        throw new Error('Packaged desktop profile was not ready');
      }
      const activated = await adapters.connection.activate(profile, probed);
      if (activated.status !== 'ready' || !activated.profileId
        || !activated.transportScope || !activated.identityEpoch) {
        throw new Error('Packaged desktop activation failed');
      }
      adapters.connection.publishActivation(profile, activated);
      const scopeGeneration = nextCurrentUserScopeGeneration;
      nextCurrentUserScopeGeneration += 1;
      await getCurrentUser({ scopeGeneration, activeScopePresent: true });
      return {
        profileId: activated.profileId,
        transportScope: activated.transportScope,
        identityEpoch: activated.identityEpoch,
        contractsContainSecret: JSON.stringify([probed, activated]).includes('propr_it_'),
      };
    },
    async rest() {
      const response = await apiFetch('/api/smoke/rest', { credentials: 'include' });
      if (!response.ok || (await response.json() as { ok?: boolean }).ok !== true) {
        throw new Error('Packaged REST fixture failed');
      }
    },
    async connectSocket() {
      const scope = getDesktopConnectionScope();
      if (!scope) throw new Error('Packaged Socket.IO scope is unavailable');
      const socket = proprClient.connectSocket(rendererSocketOptions(scope.transportScope));
      const id = nextSocketId++;
      sockets.set(id, { socket, profileId: scope.profileId, transportScope: scope.transportScope });
      await waitForSocket(socket, 'connect');
      return id;
    },
    async reconnectSocket(id) {
      const record = sockets.get(id);
      if (!record) throw new Error('Packaged Socket.IO connection is unavailable');
      record.socket.disconnect();
      const connected = waitForSocket(record.socket, 'connect');
      record.socket.connect();
      await connected;
    },
    async expectSocketRejected(id) {
      const record = sockets.get(id);
      const currentScope = getDesktopConnectionScope();
      if (!record || !currentScope || currentScope.profileId !== record.profileId
        || currentScope.transportScope === record.transportScope) {
        throw new Error('Packaged stale Socket.IO activation was not rotated');
      }
      record.socket.disconnect();
      record.socket.io.opts.query = staleReconnectQuery(
        record.transportScope,
        currentScope.transportScope,
      );
      const rejected = waitForSocket(record.socket, 'connect_error');
      try {
        record.socket.connect();
        await rejected;
      } finally {
        record.socket.disconnect();
      }

      // A distinct Manager carrying only the newly activated opaque scope must
      // still succeed after main rejects the recorded stale scope above.
      const freshSocket = proprClient.connectSocket(rendererSocketOptions(currentScope.transportScope));
      try {
        await waitForSocket(freshSocket, 'connect');
      } finally {
        freshSocket.disconnect();
      }
      return { transportRejected: true, freshManagerConnected: true };
    },
    disconnectSocket(id) { sockets.get(id)?.socket.disconnect(); },
    handleStaleInvalidation(profileId, transportScope) {
      return handleDesktopAccessCode('INVALID_INSTANCE_TOKEN', { bridge, profileId, transportScope });
    },
    rendererEvidence() {
      const scope = getDesktopConnectionScope();
      return {
        origin: location.origin,
        href: location.href,
        localStorage: Object.entries(localStorage),
        sessionStorage: Object.entries(sessionStorage),
        scope: scope && { profileId: scope.profileId, transportScope: scope.transportScope },
      };
    },
  };
  return harness;
};

export const installPackagedTransportSmokeHarness = (): void => {
  const bridge = window.__PROPR_DESKTOP__;
  if (!bridge) throw new Error('Packaged renderer bridge is unavailable');
  const harness = createPackagedTransportSmokeHarness(bridge);
  Object.defineProperty(window, '__proprPackagedTransportSmoke', {
    configurable: false,
    enumerable: false,
    value: Object.freeze(harness),
    writable: false,
  });
};
