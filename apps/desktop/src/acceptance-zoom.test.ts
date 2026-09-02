import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createPackagedAcceptanceZoomBridge,
  PACKAGED_ACCEPTANCE_ZOOM_APPLY_CHANNEL,
  PACKAGED_ACCEPTANCE_ZOOM_AUTH_CHANNEL,
  registerPackagedAcceptanceZoomIpc,
  type PackagedAcceptancePreloadIpc,
} from './acceptance-zoom';

class FakeIpcMain {
  readonly listeners = new Map<string, (event: any, request: unknown) => void>();
  readonly handlers = new Map<string, (event: any, factor: unknown) => unknown>();

  on(channel: string, listener: (event: any, request: unknown) => void): void { this.listeners.set(channel, listener); }
  removeListener(channel: string, listener: (event: any, request: unknown) => void): void {
    if (this.listeners.get(channel) === listener) this.listeners.delete(channel);
  }
  handle(channel: string, listener: (event: any, factor: unknown) => unknown): void { this.handlers.set(channel, listener); }
  removeHandler(channel: string): void { this.handlers.delete(channel); }
}

const webContents = () => ({ isDestroyed: () => false });

describe('packaged acceptance Electron zoom authorization', () => {
  it('registers no IPC capability outside the already-authorized acceptance mode', () => {
    const ipcMain = new FakeIpcMain();
    const dispose = registerPackagedAcceptanceZoomIpc({
      authorized: false,
      ipcMain: ipcMain as never,
      webContents: webContents() as never,
    });
    assert.equal(ipcMain.listeners.size, 0);
    assert.equal(ipcMain.handlers.size, 0);
    dispose();
  });

  it('binds fixed channels, sender, protocol, and the exact finite factor allowlist', async () => {
    const ipcMain = new FakeIpcMain();
    const trusted = webContents();
    const untrusted = webContents();
    const dispose = registerPackagedAcceptanceZoomIpc({
      authorized: true,
      ipcMain: ipcMain as never,
      webContents: trusted as never,
    });
    assert.deepEqual([...ipcMain.listeners.keys()], [PACKAGED_ACCEPTANCE_ZOOM_AUTH_CHANNEL]);
    assert.deepEqual([...ipcMain.handlers.keys()], [PACKAGED_ACCEPTANCE_ZOOM_APPLY_CHANNEL]);

    const authorize = ipcMain.listeners.get(PACKAGED_ACCEPTANCE_ZOOM_AUTH_CHANNEL)!;
    const rejected: any = { sender: untrusted, returnValue: undefined };
    authorize(rejected, { protocolVersion: 1 });
    assert.equal(rejected.returnValue, null);
    const malformed: any = { sender: trusted, returnValue: undefined };
    authorize(malformed, { protocolVersion: 1, extra: true });
    assert.equal(malformed.returnValue, null);
    const admitted: any = { sender: trusted, returnValue: undefined };
    authorize(admitted, { protocolVersion: 1 });
    assert.deepEqual(admitted.returnValue, { authorized: true, protocolVersion: 1 });

    const apply = ipcMain.handlers.get(PACKAGED_ACCEPTANCE_ZOOM_APPLY_CHANNEL)!;
    assert.deepEqual(await apply({ sender: trusted }, 1), { authorized: true, requestedFactor: 1 });
    assert.deepEqual(await apply({ sender: trusted }, 2), { authorized: true, requestedFactor: 2 });
    for (const rejectedFactor of [0, 1.5, 3, '2', null, { factor: 2 }]) {
      assert.throws(() => apply({ sender: trusted }, rejectedFactor), /not allowlisted/);
    }
    assert.throws(() => apply({ sender: untrusted }, 2), /sender is not authorized/);

    dispose();
    dispose();
    assert.equal(ipcMain.listeners.size, 0);
    assert.equal(ipcMain.handlers.size, 0);
  });
});

describe('packaged acceptance Electron zoom preload bridge', () => {
  it('does not attest or expose a bridge without the exact acceptance environment', () => {
    let syncCalls = 0;
    const ipc: PackagedAcceptancePreloadIpc = {
      sendSync: () => { syncCalls += 1; return { authorized: true, protocolVersion: 1 }; },
      invoke: async () => ({ authorized: true, requestedFactor: 1 }),
    };
    const frame = { setZoomFactor() {}, getZoomFactor: () => 1 };
    for (const environmentValue of [undefined, '', '0', 'true', '01', '1 ']) {
      assert.equal(createPackagedAcceptanceZoomBridge(ipc, frame, environmentValue), null);
    }
    assert.equal(syncCalls, 0);
  });

  it('fails closed on an absent or malformed main acknowledgement', () => {
    const frame = { setZoomFactor() {}, getZoomFactor: () => 1 };
    for (const acknowledgement of [
      undefined,
      null,
      false,
      { authorized: false, protocolVersion: 1 },
      { authorized: true, protocolVersion: 2 },
      { authorized: true, protocolVersion: 1, extra: true },
    ]) {
      const ipc: PackagedAcceptancePreloadIpc = {
        sendSync: () => acknowledgement,
        invoke: async () => undefined,
      };
      assert.equal(createPackagedAcceptanceZoomBridge(ipc, frame, '1'), null);
    }
  });

  it('accepts exact environment plus main attestation with real preload argv lacking the main switch', async () => {
    let current = 2;
    const calls: number[] = [];
    const ipc: PackagedAcceptancePreloadIpc = {
      sendSync: () => ({ authorized: true, protocolVersion: 1 }),
      invoke: async (_channel, factor) => ({ authorized: true, requestedFactor: factor }),
    };
    const originalArgv = process.argv;
    const originalEnvironment = process.env.PROPR_DESKTOP_ACCEPTANCE_TEST;
    let bridge: ReturnType<typeof createPackagedAcceptanceZoomBridge>;
    try {
      process.argv = ['/opt/ProPR Desktop/propr-desktop', '--type=renderer'];
      process.env.PROPR_DESKTOP_ACCEPTANCE_TEST = '1';
      bridge = createPackagedAcceptanceZoomBridge(ipc, {
        setZoomFactor(factor) { calls.push(factor); current = factor; },
        getZoomFactor: () => current,
      });
    } finally {
      process.argv = originalArgv;
      if (originalEnvironment === undefined) delete process.env.PROPR_DESKTOP_ACCEPTANCE_TEST;
      else process.env.PROPR_DESKTOP_ACCEPTANCE_TEST = originalEnvironment;
    }
    assert.ok(bridge);
    assert.equal(Object.isFrozen(bridge), true);
    assert.deepEqual(Object.keys(bridge), ['setZoomFactor']);
    assert.deepEqual(await bridge.setZoomFactor(2), {
      requestedFactor: 2, resetFactor: 1, appliedFactor: 2, mechanism: 'electron-web-frame',
    });
    assert.deepEqual(calls, [1, 2]);
    await assert.rejects(bridge.setZoomFactor(1.5 as never), /not allowlisted/);
    assert.deepEqual(calls, [1, 2]);

    const malformedApply = createPackagedAcceptanceZoomBridge({
      sendSync: () => ({ authorized: true, protocolVersion: 1 }),
      invoke: async () => ({ authorized: true, requestedFactor: 2, extra: true }),
    }, { setZoomFactor() {}, getZoomFactor: () => 1 }, '1');
    assert.ok(malformedApply);
    await assert.rejects(malformedApply.setZoomFactor(2), /acknowledgement is malformed/);
  });

  it('fails closed when reset or application reads back the wrong real webFrame factor', async () => {
    const ipc: PackagedAcceptancePreloadIpc = {
      sendSync: () => ({ authorized: true, protocolVersion: 1 }),
      invoke: async (_channel, factor) => ({ authorized: true, requestedFactor: factor }),
    };
    const resetFailure = createPackagedAcceptanceZoomBridge(ipc, {
      setZoomFactor() {}, getZoomFactor: () => 2,
    }, '1');
    assert.ok(resetFailure);
    await assert.rejects(resetFailure.setZoomFactor(2), /zoom reset failed/);

    let reads = 0;
    const applyFailure = createPackagedAcceptanceZoomBridge(ipc, {
      setZoomFactor() {}, getZoomFactor: () => (++reads === 1 ? 1 : 1),
    }, '1');
    assert.ok(applyFailure);
    await assert.rejects(applyFailure.setZoomFactor(2), /zoom application failed/);
  });
});
