import type { Socket } from '@propr/client';
import { DESKTOP_TRANSPORT_SCOPE_QUERY } from '@propr/shared';
import type { DesktopBridge } from '../../../apps/desktop/src/shared/contract';
import {
  apiFetch,
  getDesktopConnectionScope,
  handleDesktopAccessCode,
  proprClient,
} from '../api/apiClient';
import { createElectronDesktopAdapters } from './electronAdapters';
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
  expectSocketRejected(id: number): Promise<void>;
  disconnectSocket(id: number): void;
  handleStaleInvalidation(profileId: string, transportScope: string): Promise<string>;
  rendererEvidence(): unknown;
}

declare global {
  interface Window {
    __proprPackagedTransportSmoke?: PackagedTransportSmokeHarness;
  }
}

const waitForSocket = (socket: Socket, expected: 'connect' | 'connect_error'): Promise<void> =>
  new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error(`Packaged Socket.IO ${expected} timed out`));
    }, 5_000);
    const connected = () => {
      cleanup();
      expected === 'connect' ? resolve() : reject(new Error('Stale Socket.IO scope unexpectedly connected'));
    };
    const failed = () => {
      cleanup();
      expected === 'connect_error' ? resolve() : reject(new Error('Packaged Socket.IO connection failed'));
    };
    const cleanup = () => {
      window.clearTimeout(timer);
      socket.off('connect', connected);
      socket.off('connect_error', failed);
    };
    socket.once('connect', connected);
    socket.once('connect_error', failed);
  });

/**
 * Packaged-only E2E driver. It deliberately composes the same adapter,
 * apiFetch, ProprClient Socket.IO transport, scope rotation, and invalidation
 * handling as the desktop application; it never receives a credential.
 */
export const installPackagedTransportSmokeHarness = (): void => {
  const bridge = window.proprDesktop as DesktopBridge | undefined;
  if (!bridge) throw new Error('Packaged preload bridge is unavailable');
  const adapters = createElectronDesktopAdapters(bridge);
  const sockets = new Map<number, SocketRecord>();
  let nextSocketId = 1;

  const harness: PackagedTransportSmokeHarness = {
    async activate(profile) {
      const probed = await adapters.connection.probe(profile);
      if (probed.status !== 'ready' || !adapters.connection.activate || !adapters.connection.publishActivation) {
        throw new Error('Packaged desktop profile was not ready');
      }
      const activated = await adapters.connection.activate(profile, probed);
      if (activated.status !== 'ready' || !activated.profileId || !activated.transportScope || !activated.identityEpoch) {
        throw new Error('Packaged desktop activation failed');
      }
      adapters.connection.publishActivation(profile, activated);
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
      const socket = proprClient.connectSocket({
        transports: ['websocket'],
        forceNew: true,
        reconnection: true,
        query: { [DESKTOP_TRANSPORT_SCOPE_QUERY]: scope.transportScope },
      });
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
      if (!record) throw new Error('Packaged Socket.IO connection is unavailable');
      record.socket.disconnect();
      const rejected = waitForSocket(record.socket, 'connect_error');
      record.socket.connect();
      await rejected;
      record.socket.disconnect();
    },
    disconnectSocket(id) {
      sockets.get(id)?.socket.disconnect();
    },
    handleStaleInvalidation(profileId, transportScope) {
      return handleDesktopAccessCode('INVALID_INSTANCE_TOKEN', { bridge, profileId, transportScope });
    },
    rendererEvidence() {
      return {
        origin: location.origin,
        href: location.href,
        localStorage: Object.entries(localStorage),
        sessionStorage: Object.entries(sessionStorage),
        scope: getDesktopConnectionScope() && {
          profileId: getDesktopConnectionScope()!.profileId,
          transportScope: getDesktopConnectionScope()!.transportScope,
        },
      };
    },
  };
  Object.defineProperty(window, '__proprPackagedTransportSmoke', {
    configurable: false,
    enumerable: false,
    value: Object.freeze(harness),
    writable: false,
  });
};
