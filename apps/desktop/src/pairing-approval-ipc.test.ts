import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { App, IpcMain, IpcMainInvokeEvent, Session } from 'electron';
import type { DesktopCredentialService } from './credential-service';
import { registerIpcHandlers } from './ipc';
import type { LocalLifecycleController } from './lifecycle';
import type { DesktopLogger } from './logger';
import type { ProfileStore } from './profile-store';
import { IPC_CHANNELS } from './shared/contract';

const operationId = '123e4567-e89b-42d3-a456-426614174000';
const rendererUrl = 'propr-renderer://app/index.html';

const register = (platform: NodeJS.Platform = 'linux') => {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const calls: Array<{ action: 'reopen' | 'copy'; profileId: string; operationId: string }> = [];
  const diagnostics: unknown[] = [];
  const credentials = {
    reopenPairingApproval: async (profileId: string, currentOperationId: string) => {
      calls.push({ action: 'reopen', profileId, operationId: currentOperationId });
      return { status: 'succeeded' as const };
    },
    copyPendingPairingApproval: async (profileId: string, currentOperationId: string) => {
      calls.push({ action: 'copy', profileId, operationId: currentOperationId });
      return { status: 'failed' as const };
    },
  } as unknown as DesktopCredentialService;
  const logger = {
    log: (_level: string, event: string, fields?: unknown) => diagnostics.push({ event, fields }),
  } as DesktopLogger;
  registerIpcHandlers({
    app: { getName: () => 'ProPR', getVersion: () => '0.8.15', isPackaged: true } as unknown as App,
    ipcMain: {
      handle: (channel: string, handler: (...args: any[]) => unknown) => { handlers.set(channel, handler); },
      removeHandler: (channel: string) => { handlers.delete(channel); },
    } as unknown as IpcMain,
    profiles: {} as ProfileStore,
    credentials,
    connectDiscovery: { discover: async () => [], rediscover: async () => null },
    lifecycle: {} as LocalLifecycleController,
    logger,
    desktopSession: {} as Session,
    devServerUrl: undefined,
    packagedRendererUrl: rendererUrl,
    openExternal: async () => undefined,
    platform,
  });
  const event = { senderFrame: { url: rendererUrl } } as unknown as IpcMainInvokeEvent;
  const invoke = (channel: string, ...args: unknown[]) =>
    Promise.resolve(handlers.get(channel)!(event, ...args));
  return { calls, diagnostics, invoke };
};

describe('desktop pairing approval recovery IPC', () => {
  it('passes only the fixed current-operation identity and logs secret-free outcomes', async () => {
    const fixture = register();
    assert.deepEqual(await fixture.invoke(
      IPC_CHANNELS.authenticationReopenApproval, 'profile-a', operationId,
    ), { status: 'succeeded' });
    assert.deepEqual(await fixture.invoke(
      IPC_CHANNELS.authenticationCopyApproval, 'profile-a', operationId,
    ), { status: 'failed' });
    assert.deepEqual(fixture.calls, [
      { action: 'reopen', profileId: 'profile-a', operationId },
      { action: 'copy', profileId: 'profile-a', operationId },
    ]);
    const serialized = JSON.stringify(fixture.diagnostics);
    assert.equal(serialized.includes('approvalUrl'), false);
    assert.equal(serialized.includes('deviceSecret'), false);
    assert.equal(serialized.includes(operationId), false);
    assert.match(serialized, /approval_action/);

    const mac = register('darwin');
    assert.deepEqual(await mac.invoke(
      IPC_CHANNELS.authenticationReopenApproval, 'profile-a', operationId,
    ), { status: 'succeeded' });
    assert.equal(mac.calls.length, 1);
  });

  it('rejects malformed or extra renderer authority and defers recovery on Windows', async () => {
    const linux = register();
    await assert.rejects(
      linux.invoke(IPC_CHANNELS.authenticationReopenApproval, 'profile-a', operationId, 'https://attacker.test'),
      /Desktop operation failed \[IPC_OPERATION_FAILED\]/,
    );
    await assert.rejects(
      linux.invoke(IPC_CHANNELS.authenticationCopyApproval, 'profile-a', 'not-an-operation'),
      /Desktop operation failed \[IPC_OPERATION_FAILED\]/,
    );
    assert.deepEqual(linux.calls, []);

    const windows = register('win32');
    assert.deepEqual(await windows.invoke(
      IPC_CHANNELS.authenticationReopenApproval, 'profile-a', operationId,
    ), { status: 'unavailable' });
    assert.deepEqual(windows.calls, []);
  });
});
