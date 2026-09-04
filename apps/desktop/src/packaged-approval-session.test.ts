import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import type { BrowserWindow, Session } from 'electron';
import {
  clearPackagedApprovalStorage,
  createPackagedApprovalNavigation,
  createPackagedApprovalTaskTracker,
  packagedApprovalPartition,
} from './packaged-approval-session';

const approvalUrl = `http://127.0.0.1:41731/api/desktop/pairings/dpr_${'A'.repeat(22)}/browser`;

type Callback<T> = (decision: T) => void;
type RequestHandler = (details: Record<string, unknown>, callback: Callback<Record<string, unknown>>) => void;
type RedirectHandler = (details: Record<string, unknown>) => void;
type CompletedHandler = (details: Record<string, unknown>) => void;

class FakeWebRequest {
  beforeRequest: RequestHandler | null = null;
  beforeSendHeaders: RequestHandler | null = null;
  sendHeaders: RedirectHandler | null = null;
  headersReceived: RequestHandler | null = null;
  beforeRedirect: RedirectHandler | null = null;
  completed: CompletedHandler | null = null;

  onBeforeRequest(handler: RequestHandler | null): void { this.beforeRequest = handler; }
  onBeforeSendHeaders(handler: RequestHandler | null): void { this.beforeSendHeaders = handler; }
  onSendHeaders(handler: RedirectHandler | null): void { this.sendHeaders = handler; }
  onHeadersReceived(handler: RequestHandler | null): void { this.headersReceived = handler; }
  onBeforeRedirect(handler: RedirectHandler | null): void { this.beforeRedirect = handler; }
  onCompleted(handler: CompletedHandler | null): void { this.completed = handler; }
}

class FakeSession extends EventEmitter {
  readonly webRequest = new FakeWebRequest();
  permissionCheck: ((...values: unknown[]) => boolean) | null = null;
  permissionRequest: ((...values: unknown[]) => void) | null = null;
  clearCount = 0;

  setPermissionCheckHandler(handler: ((...values: unknown[]) => boolean) | null): void {
    this.permissionCheck = handler;
  }

  setPermissionRequestHandler(handler: ((...values: unknown[]) => void) | null): void {
    this.permissionRequest = handler;
  }

  async clearStorageData(): Promise<void> { this.clearCount += 1; }
}

class FakeContents extends EventEmitter {
  readonly id = 91;
  readonly mainFrame = { detached: false, parent: null };
  currentUrl = '';
  openHandler: (() => { action: 'deny' }) | null = null;

  constructor(readonly session: FakeSession) { super(); }

  setWindowOpenHandler(handler: () => { action: 'deny' }): void { this.openHandler = handler; }
  getURL(): string { return this.currentUrl; }
}

class FakeWindow {
  readonly webContents: FakeContents;
  destroyed = false;
  destroyCount = 0;
  load: (url: string) => Promise<void> = async () => undefined;

  constructor(approvalSession: FakeSession) {
    this.webContents = new FakeContents(approvalSession);
  }

  loadURL(url: string): Promise<void> { return this.load(url); }
  isDestroyed(): boolean { return this.destroyed; }
  destroy(): void { this.destroyed = true; this.destroyCount += 1; }
}

const event = () => {
  let prevented = false;
  return {
    preventDefault: () => { prevented = true; },
    get prevented() { return prevented; },
  };
};

const decision = async (
  handler: RequestHandler | null,
  details: Record<string, unknown>,
): Promise<Record<string, unknown>> => {
  assert.ok(handler);
  return await new Promise(resolve => handler(details, resolve));
};

interface Harness {
  approvalSession: FakeSession;
  defaultSession: FakeSession;
  window: FakeWindow;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string[]>;
}

const harness = (statusCode = 200): Harness => {
  const approvalSession = new FakeSession();
  const defaultSession = new FakeSession();
  const window = new FakeWindow(approvalSession);
  const requestHeaders: Record<string, string> = { Accept: 'text/html' };
  const responseHeaders: Record<string, string[]> = {
    'Content-Type': ['text/html'],
    'Set-Cookie': ['approval=secret'],
  };
  window.load = async url => {
    const details = {
      id: 7,
      url,
      method: 'GET',
      webContentsId: window.webContents.id,
      webContents: window.webContents,
      frame: window.webContents.mainFrame,
      resourceType: 'mainFrame',
    };
    const start = await decision(approvalSession.webRequest.beforeRequest, details);
    if (start.cancel === true) throw new Error('cancelled');
    const outgoing = await decision(approvalSession.webRequest.beforeSendHeaders, {
      ...details,
      requestHeaders,
    });
    if (outgoing.cancel === true) throw new Error('cancelled');
    Object.assign(requestHeaders, outgoing.requestHeaders);
    approvalSession.webRequest.sendHeaders?.({
      ...details,
      requestHeaders,
    });
    const incoming = await decision(approvalSession.webRequest.headersReceived, {
      ...details,
      statusCode,
      responseHeaders,
    });
    if (incoming.cancel === true) throw new Error('cancelled');
    for (const name of Object.keys(responseHeaders)) delete responseHeaders[name];
    Object.assign(responseHeaders, incoming.responseHeaders);
    window.webContents.currentUrl = url;
    window.webContents.emit('did-frame-navigate', event(), url, statusCode, 'OK', true, 1, 1);
    approvalSession.webRequest.completed?.({ ...details, statusCode });
  };
  return { approvalSession, defaultSession, window, requestHeaders, responseHeaders };
};

const controllerFor = (value: Harness) => createPackagedApprovalNavigation({
  approvalUrl,
  approvalSession: value.approvalSession as unknown as Session,
  approvalWindow: value.window as unknown as BrowserWindow,
  defaultSession: value.defaultSession as unknown as Session,
});

describe('packaged pairing approval isolated session', () => {
  it('uses non-persistent unique partition names and rejects invalid entropy', () => {
    const first = packagedApprovalPartition('a'.repeat(32));
    const second = packagedApprovalPartition('b'.repeat(32));
    assert.notEqual(first, second);
    assert.equal(first.startsWith('persist:'), false);
    assert.throws(() => packagedApprovalPartition('../shared'));
  });

  it('allows one exact credentialless main-frame GET and strips response cookies', async () => {
    const value = harness();
    const controller = controllerFor(value);
    assert.equal(value.approvalSession.permissionCheck?.(), false);
    let permissionAllowed = true;
    value.approvalSession.permissionRequest?.(null, 'notifications', (allowed: boolean) => {
      permissionAllowed = allowed;
    });
    assert.equal(permissionAllowed, false);

    await controller.navigate();

    assert.equal(Object.keys(value.requestHeaders).some(name => /^(authorization|cookie)$/iu.test(name)), false);
    assert.equal(Object.keys(value.responseHeaders).some(name => /^set-cookie2?$/iu.test(name)), false);
    await controller.cleanup();
  });

  it('waits for an exact completion event that arrives after loadURL resolves', async () => {
    const value = harness();
    const controller = controllerFor(value);
    const originalLoad = value.window.load;
    let finishCompletion: (() => void) | undefined;
    value.window.load = async url => {
      const onCompleted = value.approvalSession.webRequest.completed;
      assert.ok(onCompleted);
      value.approvalSession.webRequest.completed = details => {
        finishCompletion = () => onCompleted(details);
      };
      await originalLoad(url);
    };

    const navigation = controller.navigate();
    let settled = false;
    void navigation.finally(() => { settled = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.ok(finishCompletion);
    assert.equal(settled, false);
    finishCompletion();
    await navigation;
    assert.equal(settled, true);
    await controller.cleanup();
  });

  it('reports owned approval readiness and drains delayed work before the next pairing case', async () => {
    const requested: string[] = [];
    const releases: Array<() => void> = [];
    const tracker = createPackagedApprovalTaskTracker<string>(async request => {
      requested.push(request);
      await new Promise<void>(resolve => { releases.push(resolve); });
    });

    for (const request of ['expiry', 'cancel', 'success']) {
      let ready = false;
      const readiness = tracker.waitForNextOpen().then(() => { ready = true; });
      const concurrentReadiness = tracker.waitForNextOpen();
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(ready, false);
      const opened = tracker.open(request);
      await Promise.all([readiness, concurrentReadiness]);
      assert.equal(ready, true);
      let idle = false;
      const drained = tracker.waitForIdle().then(() => { idle = true; });
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(idle, false);
      assert.equal(requested.filter(value => value === request).length, 1);
      releases.shift()?.();
      await Promise.all([opened, drained]);
      assert.equal(idle, true);
    }

    assert.deepEqual(requested, ['expiry', 'cancel', 'success']);
  });

  it('cancels an incidental resource without invalidating the exact main-frame approval', async () => {
    const value = harness();
    const originalLoad = value.window.load;
    value.window.load = async url => {
      const incidental = await decision(value.approvalSession.webRequest.beforeRequest, {
        id: 6,
        url: 'http://127.0.0.1:41731/favicon.ico',
        method: 'GET',
        webContentsId: value.window.webContents.id,
        webContents: value.window.webContents,
        frame: value.window.webContents.mainFrame,
        resourceType: 'image',
      });
      assert.deepEqual(incidental, { cancel: true });
      await originalLoad(url);
    };

    const controller = controllerFor(value);
    await controller.navigate();
    await controller.cleanup();
  });

  it('rejects redirects, alternate origins and paths, methods, subframes, and credential headers', async t => {
    for (const scenario of [
      'redirect',
      'off-origin',
      'path',
      'method',
      'subframe',
      'status',
      'authorization',
      'cookie',
    ] as const) {
      await t.test(scenario, async () => {
        const value = harness(scenario === 'status' ? 204 : 200);
        const original = value.window.load;
        if (scenario === 'redirect') {
          value.window.load = async url => {
            value.approvalSession.webRequest.beforeRedirect?.({
              id: 7,
              url,
              method: 'GET',
              redirectURL: 'https://attacker.example.test/',
            });
            const redirect = event();
            value.window.webContents.emit('will-redirect', redirect);
            assert.equal(redirect.prevented, true);
            throw new Error('redirect cancelled');
          };
        } else if (scenario === 'status') {
          // The default loader supplies a non-exact successful response status.
        } else if (scenario === 'authorization' || scenario === 'cookie') {
          value.requestHeaders[scenario === 'authorization' ? 'Authorization' : 'Cookie'] = 'secret';
        } else {
          value.window.load = async () => {
            const changed = {
              id: 7,
              url: scenario === 'off-origin'
                ? 'http://127.0.0.2:41731/api/desktop/pairings/other/browser'
                : scenario === 'path'
                  ? `${approvalUrl}/extra`
                  : approvalUrl,
              method: scenario === 'method' ? 'POST' : 'GET',
              webContentsId: value.window.webContents.id,
              webContents: value.window.webContents,
              frame: scenario === 'subframe' ? { parent: value.window.webContents.mainFrame } : value.window.webContents.mainFrame,
              resourceType: scenario === 'subframe' ? 'subFrame' : 'mainFrame',
            };
            const result = await decision(value.approvalSession.webRequest.beforeRequest, changed);
            assert.deepEqual(result, { cancel: true });
            throw new Error('cancelled');
          };
        }
        const controller = controllerFor(value);
        await assert.rejects(controller.navigate(), { message: 'Packaged pairing browser approval was rejected' });
        await controller.cleanup();
        value.window.load = original;
      });
    }
  });

  it('rejects popups, downloads, webviews, and external renderer navigation', async t => {
    for (const scenario of ['popup', 'download', 'webview', 'navigation'] as const) {
      await t.test(scenario, async () => {
        const value = harness();
        const original = value.window.load;
        value.window.load = async url => {
          await original(url);
          const blocked = event();
          if (scenario === 'popup') {
            assert.deepEqual(value.window.webContents.openHandler?.(), { action: 'deny' });
          } else if (scenario === 'download') {
            value.approvalSession.emit('will-download', blocked);
          } else if (scenario === 'webview') {
            value.window.webContents.emit('will-attach-webview', blocked);
          } else {
            value.window.webContents.emit('will-navigate', blocked);
          }
          if (scenario !== 'popup') assert.equal(blocked.prevented, true);
        };
        const controller = controllerFor(value);
        await assert.rejects(controller.navigate(), { message: 'Packaged pairing browser approval was rejected' });
        await controller.cleanup();
      });
    }
  });

  it('rejects default/mismatched/reused sessions and cleans up idempotently', async () => {
    const defaultValue = harness();
    assert.throws(() => createPackagedApprovalNavigation({
      approvalUrl,
      approvalSession: defaultValue.defaultSession as unknown as Session,
      approvalWindow: defaultValue.window as unknown as BrowserWindow,
      defaultSession: defaultValue.defaultSession as unknown as Session,
    }), { message: 'Packaged pairing browser approval was rejected' });

    const value = harness();
    const controller = controllerFor(value);
    assert.throws(() => controllerFor(value), { message: 'Packaged pairing browser approval was rejected' });
    await controller.navigate();
    await assert.rejects(controller.navigate(), { message: 'Packaged pairing browser approval was rejected' });
    const firstCleanup = controller.cleanup();
    const secondCleanup = controller.cleanup();
    assert.equal(firstCleanup, secondCleanup);
    await Promise.all([firstCleanup, secondCleanup]);

    assert.equal(value.window.destroyCount, 1);
    assert.equal(value.approvalSession.clearCount, 1);
    assert.equal(value.approvalSession.permissionCheck, null);
    assert.equal(value.approvalSession.permissionRequest, null);
    assert.equal(value.approvalSession.listenerCount('will-download'), 0);
    assert.equal(value.window.webContents.listenerCount('will-navigate'), 0);
    assert.equal(value.approvalSession.webRequest.beforeRequest, null);
    assert.equal(value.approvalSession.webRequest.beforeSendHeaders, null);
    assert.equal(value.approvalSession.webRequest.sendHeaders, null);
    assert.equal(value.approvalSession.webRequest.headersReceived, null);
    assert.equal(value.approvalSession.webRequest.beforeRedirect, null);
    assert.equal(value.approvalSession.webRequest.completed, null);
  });

  it('bounds storage cleanup, reports failures, and never makes the session reusable', async () => {
    const stalled = new FakeSession();
    stalled.clearStorageData = () => new Promise<void>(() => undefined);
    await assert.rejects(
      clearPackagedApprovalStorage(stalled as unknown as Session, 5),
      { message: 'Packaged pairing browser approval cleanup failed' },
    );

    const value = harness();
    value.approvalSession.clearStorageData = async () => { throw new Error('private cleanup detail'); };
    const controller = controllerFor(value);
    await controller.navigate();
    const firstCleanup = controller.cleanup();
    assert.equal(firstCleanup, controller.cleanup());
    await assert.rejects(firstCleanup, { message: 'Packaged pairing browser approval cleanup failed' });
    assert.throws(() => controllerFor(value), { message: 'Packaged pairing browser approval was rejected' });
  });
});
