import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { App, IpcMain, IpcMainInvokeEvent, Session } from 'electron';
import type { ConnectStatusDocument } from '@propr/cli/desktop-discovery';
import { DesktopConnectDiscoveryService } from '../../../apps/desktop/src/connect-discovery';
import type { DesktopCredentialService } from '../../../apps/desktop/src/credential-service';
import { registerIpcHandlers } from '../../../apps/desktop/src/ipc';
import type { LocalLifecycleController } from '../../../apps/desktop/src/lifecycle';
import type { DesktopLogger } from '../../../apps/desktop/src/logger';
import { createDesktopBridge, type PreloadIpc } from '../../../apps/desktop/src/preload-bridge';
import type { ProfileStore } from '../../../apps/desktop/src/profile-store';
import { IPC_CHANNELS } from '../../../apps/desktop/src/shared/contract';
import { DesktopExperience } from './DesktopExperience';
import { createElectronDesktopAdapters } from './electronAdapters';

vi.mock('../api/apiClient', () => ({
  getDesktopConnectionScope: () => null,
  setApiBaseUrl: vi.fn(),
  setDesktopConnectionScope: vi.fn(),
}));
vi.mock('../config/runtimeConfig', () => ({ setDesktopApiBaseUrl: vi.fn() }));

const rendererUrl = 'propr-app://renderer/renderer.html';

const readyStatus: ConnectStatusDocument = {
  schemaVersion: 1,
  status: 'ready',
  canonicalEndpoint: 'https://t-discovered123.propr.dev',
  publicInstanceIdentity: '123e4567-e89b-42d3-a456-426614174000',
  configured: true,
  enabled: true,
  sidecarRunning: true,
  apiReady: true,
  restartRequired: false,
  compatibility: '2026-08-01',
  version: '0.8.15',
  reasonCodes: [],
};

describe('DesktopExperience production Connect discovery pipeline', () => {
  it('flows fixed-root main discovery through IPC, preload, and Electron adapters without persistence', async () => {
    type InvokeHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;
    const handlers = new Map<string, InvokeHandler>();
    const invocations: Array<{ channel: string; args: unknown[] }> = [];
    const credentials = {
      listProfiles: vi.fn(async () => ({ profiles: [], activeProfileId: null })),
      saveProfile: vi.fn(),
    } as unknown as DesktopCredentialService;
    const connectDiscovery = new DesktopConnectDiscoveryService({
      list: async () => ({ profiles: [], activeProfileId: null }),
    }, {
      supported: true,
      discover: async () => readyStatus,
    });
    const registered = registerIpcHandlers({
      app: { getName: () => 'ProPR', getVersion: () => '0.8.15', isPackaged: true } as unknown as App,
      ipcMain: {
        handle: (channel: string, handler: InvokeHandler) => { handlers.set(channel, handler); },
        removeHandler: (channel: string) => { handlers.delete(channel); },
      } as unknown as IpcMain,
      profiles: {} as ProfileStore,
      credentials,
      connectDiscovery,
      lifecycle: {} as LocalLifecycleController,
      logger: { log: () => undefined } as unknown as DesktopLogger,
      desktopSession: {} as Session,
      devServerUrl: undefined,
      packagedRendererUrl: rendererUrl,
      openExternal: async () => undefined,
    });
    const event = { senderFrame: { url: rendererUrl } } as unknown as IpcMainInvokeEvent;
    const ipc: PreloadIpc = {
      invoke: (channel, ...args) => {
        invocations.push({ channel, args });
        return Promise.resolve(handlers.get(channel)!(event, ...args));
      },
      on: () => undefined,
      removeListener: () => undefined,
    };
    const adapters = createElectronDesktopAdapters(createDesktopBridge(ipc, true));

    render(<DesktopExperience adapters={adapters}><div>Connected app</div></DesktopExperience>);
    fireEvent.click(await screen.findByRole('button', { name: /Search for instances on this network/i }));

    expect(await screen.findByRole('heading', { name: 'Edit instance' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Verified ProPR Connect endpoint');
    expect(screen.getByLabelText('Instance URL')).toHaveValue('https://t-discovered123.propr.dev');
    expect(credentials.saveProfile).not.toHaveBeenCalled();
    await waitFor(() => expect(invocations).toContainEqual({
      channel: IPC_CHANNELS.connectDiscover,
      args: [],
    }));
    expect(invocations.find(item => item.channel === IPC_CHANNELS.connectDiscover)?.args).toEqual([]);
    registered.dispose();
  });
});
