import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { describe, it } from 'node:test';
import type { App, IpcMain, IpcMainInvokeEvent, Session } from 'electron';
import type { PairingProtocolRequestOptions } from '@propr/client';
import { DesktopCredentialService } from './credential-service';
import { registerIpcHandlers } from './ipc';
import type { LocalLifecycleController } from './lifecycle';
import type { DesktopLogger } from './logger';
import { ProfileStore, type EncryptionProvider } from './profile-store';
import { IPC_CHANNELS } from './shared/contract';
import { createDesktopShutdownCoordinator } from './shutdown';

type Endpoint = 'start' | 'poll' | 'activate' | 'cancel';
type BarrierPhase = 'header' | 'body' | 'reader-cancel' | 'body-cancel';

interface Scenario {
  name: string;
  endpoint: Endpoint;
  phase: BarrierPhase;
}

const scenarios: readonly Scenario[] = [
  { name: 'start-header', endpoint: 'start', phase: 'header' },
  { name: 'start-body', endpoint: 'start', phase: 'body' },
  { name: 'poll-header', endpoint: 'poll', phase: 'header' },
  { name: 'poll-body', endpoint: 'poll', phase: 'body' },
  { name: 'activate-header', endpoint: 'activate', phase: 'header' },
  { name: 'activate-body', endpoint: 'activate', phase: 'body' },
  { name: 'cancel-header', endpoint: 'cancel', phase: 'header' },
  { name: 'cancel-body', endpoint: 'cancel', phase: 'body' },
  { name: 'never-settling-reader-cancel', endpoint: 'activate', phase: 'reader-cancel' },
  { name: 'never-settling-body-cancel', endpoint: 'activate', phase: 'body-cancel' },
];

const encryption: EncryptionProvider = {
  isEncryptionAvailable: () => true,
  backend: () => 'keychain',
  encrypt: value => Buffer.from(Buffer.from(value, 'utf8').toString('base64url'), 'utf8'),
  decrypt: value => Buffer.from(value.toString(), 'base64url').toString('utf8'),
};

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

const deferred = <T,>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((settle, fail) => { resolve = settle; reject = fail; });
  return { promise, resolve, reject };
};

class ProtocolClock {
  #now = 0;
  #nextId = 1;
  readonly #timers = new Map<number, { at: number; callback: () => void }>();

  readonly source: NonNullable<PairingProtocolRequestOptions['clock']> = {
    now: () => this.#now,
    setTimeout: (callback, milliseconds) => {
      const id = this.#nextId++;
      this.#timers.set(id, { at: this.#now + milliseconds, callback });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: timer => { this.#timers.delete(timer as unknown as number); },
  };

  get pending(): number { return this.#timers.size; }

  async advance(milliseconds: number): Promise<void> {
    const target = this.#now + milliseconds;
    while (true) {
      const due = [...this.#timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort(([leftId, left], [rightId, right]) => left.at - right.at || leftId - rightId)[0];
      if (!due) break;
      this.#now = due[1].at;
      this.#timers.delete(due[0]);
      due[1].callback();
      await Promise.resolve();
      await Promise.resolve();
    }
    this.#now = target;
    await Promise.resolve();
    await Promise.resolve();
  }
}

const bounded = async <T,>(promise: Promise<T>, milliseconds = 1_000): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('desktop shutdown did not settle')), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const durableBytes = async (root: string): Promise<Record<string, string>> => {
  const snapshot: Record<string, string> = {};
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else snapshot[relative(root, path)] = (await readFile(path)).toString('base64');
    }
  };
  await visit(root);
  return Object.fromEntries(Object.entries(snapshot).sort(([left], [right]) => left.localeCompare(right)));
};

const immediate = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

describe('desktop pairing service IPC native shutdown lifecycle', () => {
  assert.equal(scenarios.length, 10);

  for (const scenario of scenarios) {
    it(`${scenario.name} drains through the real service, IPC gate, and before-quit order`, async () => {
      const directory = await mkdtemp(join(tmpdir(), `propr-${scenario.name}-`));
      const clock = new ProtocolClock();
      const barrier = deferred<void>();
      const lateHeader = deferred<Response>();
      const lateCancellation = deferred<void>();
      const cancellationStarted = deferred<void>();
      const protocolNow = Date.parse('2026-01-01T00:00:00.000Z');
      const expiresAt = new Date(protocolNow + 10_000).toISOString();
      const profileId = `profile-${scenario.name}`;
      const origin = 'https://a.example.test';
      const provisionalToken = `propr_it_${'C'.repeat(43)}`;
      const counts = {
        fetchStart: 0,
        fetchAbort: 0,
        bodyPull: 0,
        bodyCancel: 0,
        profileRead: 0,
        profileWrite: 0,
        profileIO: 0,
        ipcEntry: 0,
        ipcExit: 0,
        rendererPublication: 0,
        sessionNetwork: 0,
      };
      const order: string[] = [];
      const unhandled: unknown[] = [];
      const onUnhandled = (error: unknown): void => { unhandled.push(error); };
      process.on('unhandledRejection', onUnhandled);

      const rawStore = new ProfileStore(directory, encryption, {
        beforeIO: () => { counts.profileIO += 1; },
      });
      const readMethods = new Set([
        'list', 'readCredential', 'readProfileCredential', 'pendingRevocations', 'security',
      ]);
      const store = new Proxy(rawStore, {
        get(target, property) {
          const value = Reflect.get(target, property, target) as unknown;
          if (typeof value !== 'function') return value;
          return (...args: unknown[]) => {
            if (readMethods.has(String(property))) counts.profileRead += 1;
            else counts.profileWrite += 1;
            return (value as (...values: unknown[]) => unknown).apply(target, args);
          };
        },
      }) as ProfileStore;

      let targetSignal: AbortSignal | undefined;
      let pairingBinding: Record<string, unknown> = {};
      let activationFailures = 0;
      let cancellationCanSettle = false;
      const stalledBody = (beforeReader: boolean): Response => new Response(
        new ReadableStream<Uint8Array>({
          pull() {
            counts.bodyPull += 1;
            if (!beforeReader) barrier.resolve(undefined);
          },
          cancel() {
            counts.bodyCancel += 1;
            if (beforeReader) barrier.resolve(undefined);
            cancellationStarted.resolve(undefined);
            return lateCancellation.promise;
          },
        }),
        {
          headers: {
            'Content-Type': 'application/json',
            ...(beforeReader ? { 'Content-Length': '4097' } : {}),
          },
        },
      );

      const fetchImplementation: typeof globalThis.fetch = async (input, init) => {
        counts.fetchStart += 1;
        const url = input.toString();
        const signal = init?.signal ?? undefined;
        signal?.addEventListener('abort', () => { counts.fetchAbort += 1; }, { once: true });
        const endpoint: Endpoint = url.endsWith('/poll')
          ? 'poll'
          : url.endsWith('/activate')
            ? 'activate'
            : url.endsWith('/cancel')
              ? 'cancel'
              : 'start';
        if (endpoint === scenario.endpoint) {
          targetSignal = signal;
          if (scenario.phase === 'header') {
            barrier.resolve(undefined);
            return lateHeader.promise;
          }
          if (scenario.phase === 'body-cancel') return stalledBody(true);
          return stalledBody(false);
        }
        if (endpoint === 'start') {
          const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
          pairingBinding = {
            instanceId: request.instanceId,
            origin: request.origin,
            scope: request.scope,
            credentialGeneration: request.credentialGeneration,
          };
          return json({
            pairingId: `dpr_${'A'.repeat(22)}`,
            deviceSecret: 'B'.repeat(43),
            approvalUrl: `${origin}/approve`,
            expiresAt,
            interval: 1,
          }, 201);
        }
        if (endpoint === 'poll') {
          return json({
            status: 'provisional',
            token: provisionalToken,
            tokenType: 'Bearer',
            activationTicket: 'T'.repeat(43),
            activationExpiresAt: expiresAt,
            ...pairingBinding,
          });
        }
        if (endpoint === 'activate') {
          if (scenario.endpoint === 'cancel') {
            activationFailures += 1;
            return json({ code: 'ACTIVATION_FAILED', error: 'activation failed' }, 500);
          }
          return json({
            status: 'active',
            receipt: 'R'.repeat(22),
            activatedAt: '2026-01-01T00:00:01.000Z',
            expiresAt: null,
          });
        }
        return json({ status: 'cancelled', cancelledAt: '2026-01-01T00:00:01.000Z' });
      };

      const handlers = new Map<string, (...args: any[]) => unknown>();
      let service!: DesktopCredentialService;
      try {
        const profile = await store.save({ id: profileId, label: scenario.name, apiBaseUrl: origin });
        service = new DesktopCredentialService({
          profiles: store,
          clientName: `Native ${scenario.name}`,
          openPairingBrowser: async () => undefined,
          fetch: fetchImplementation,
          pairingTiming: { now: () => protocolNow, sleep: async () => undefined },
          pairingProtocol: {
            overallTimeoutMs: 1_000,
            deadlines: { headerMs: 500, bodyMs: 500, cancellationMs: 100 },
            clock: clock.source,
            reportDiagnostic: () => undefined,
          },
        });
        assert.deepEqual(await service.initialize(), { status: 'ready', retryPending: false });

        const desktopSession = {
          fetch: async () => { counts.sessionNetwork += 1; return new Response(null, { status: 204 }); },
          clearStorageData: async () => undefined,
        } as unknown as Session;
        const registered = registerIpcHandlers({
          app: {
            getName: () => 'ProPR', getVersion: () => '0.8.15', isPackaged: true,
          } as unknown as App,
          ipcMain: {
            handle: (channel: string, handler: (...args: any[]) => unknown) => { handlers.set(channel, handler); },
            removeHandler: (channel: string) => { handlers.delete(channel); },
          } as unknown as IpcMain,
          profiles: store,
          credentials: service,
          connectDiscovery: {
            discover: async () => [],
            rediscover: async () => null,
          },
          lifecycle: {} as LocalLifecycleController,
          logger: { log: () => undefined } as unknown as DesktopLogger,
          desktopSession,
          devServerUrl: undefined,
          packagedRendererUrl: 'propr-renderer://app/index.html',
          openExternal: async () => undefined,
          observeInvocation: phase => { counts[phase === 'entry' ? 'ipcEntry' : 'ipcExit'] += 1; },
        });
        const event = {
          senderFrame: { url: 'propr-renderer://app/index.html' },
        } as unknown as IpcMainInvokeEvent;
        const invoke = (channel: string, ...args: unknown[]): Promise<unknown> =>
          Promise.resolve(handlers.get(channel)!(event, ...args));

        const admitted = invoke(IPC_CHANNELS.authenticationPair, {
          id: profile.id, label: profile.label, apiBaseUrl: profile.apiBaseUrl,
        }).then(value => {
          counts.rendererPublication += 1;
          return { status: 'fulfilled' as const, value };
        }, error => ({ status: 'rejected' as const, error }));
        await bounded(barrier.promise);

        const provisionalCouldExist = ['activate', 'cancel'].includes(scenario.endpoint);
        const pendingBeforeShutdown = await store.pendingRevocations();
        assert.equal(pendingBeforeShutdown.length, provisionalCouldExist ? 1 : 0);
        if (provisionalCouldExist) {
          assert.deepEqual(pendingBeforeShutdown[0].credential, {
            version: 1, profileId, origin, token: provisionalToken,
          });
        }
        assert.equal(await store.readCredential(profileId), null);

        let windowDestroyed = false;
        let shutdownFinished = false;
        let finalQuitCalls = 0;
        let allowedFinalQuits = 0;
        let shutdown!: ReturnType<typeof createDesktopShutdownCoordinator>;
        shutdown = createDesktopShutdownCoordinator({
          credentials: {
            dispose: () => { order.push('credentials-dispose'); return service.dispose(); },
          },
          lifecycle: {
            shutdown: async () => { order.push('lifecycle-shutdown'); },
          },
          ipc: {
            close: () => { order.push('ipc-close'); registered.close(); },
            awaitIdle: () => { order.push('ipc-drain'); return registered.awaitIdle(); },
            dispose: () => { order.push('ipc-dispose'); registered.dispose(); },
          },
          profiles: {
            close: () => { order.push('profiles-close'); return store.close(); },
          },
          sessionSecurity: {
            close: () => { order.push('session-close'); },
            dispose: () => { order.push('session-dispose'); },
          },
          disposeRendererProtocol: () => { order.push('protocol-dispose'); },
          getWindow: () => ({
            isDestroyed: () => windowDestroyed,
            destroy: () => { windowDestroyed = true; order.push('window-destroy'); },
          }),
          quit: () => {
            finalQuitCalls += 1;
            order.push('app-quit');
            let finalQuitPrevented = false;
            shutdown.beforeQuit({ preventDefault: () => { finalQuitPrevented = true; } });
            if (!finalQuitPrevented) {
              allowedFinalQuits += 1;
              shutdownFinished = true;
            }
          },
          onStarted: () => { order.push('shutdown-started'); },
          log: () => undefined,
        });
        let prevented = 0;
        shutdown.beforeQuit({ preventDefault: () => { prevented += 1; } });
        assert.equal(prevented, 1);
        assert.equal(shutdown.started, true);
        assert.deepEqual(order.slice(0, 4), [
          'shutdown-started', 'ipc-close', 'session-close', 'protocol-dispose',
        ]);

        const callsBeforeLate = {
          fetchStart: counts.fetchStart,
          profileRead: counts.profileRead,
          profileWrite: counts.profileWrite,
          sessionNetwork: counts.sessionNetwork,
        };
        await Promise.all([
          assert.rejects(invoke(IPC_CHANNELS.profilesList), /DESKTOP_CLOSING/),
          assert.rejects(invoke(IPC_CHANNELS.authenticationPair, {
            id: profile.id, label: profile.label, apiBaseUrl: profile.apiBaseUrl,
          }), /DESKTOP_CLOSING/),
          assert.rejects(invoke(IPC_CHANNELS.authLogout, origin), /DESKTOP_CLOSING/),
        ]);
        assert.deepEqual({
          fetchStart: counts.fetchStart,
          profileRead: counts.profileRead,
          profileWrite: counts.profileWrite,
          sessionNetwork: counts.sessionNetwork,
        }, callsBeforeLate);

        const cancellationExpected = scenario.phase !== 'header';
        if (cancellationExpected) {
          await bounded(cancellationStarted.promise);
          shutdown.beforeQuit({ preventDefault: () => { prevented += 1; } });
          assert.equal(prevented, 2, 'repeated before-quit was not prevented during cancellation');
          cancellationCanSettle = true;
          await clock.advance(99);
          await Promise.resolve();
          assert.equal(shutdownFinished, false, 'untrusted cancellation escaped its 100ms budget');
          await clock.advance(1);
        } else {
          shutdown.beforeQuit({ preventDefault: () => { prevented += 1; } });
          assert.equal(prevented, 2, 'repeated before-quit was not prevented during header drain');
        }
        await bounded(shutdown.awaitFinished());
        const original = await bounded(admitted);
        assert.equal(original.status, 'rejected');
        if (original.status === 'rejected') {
          assert.match(String(original.error), /Desktop operation failed \[IPC_OPERATION_FAILED\]/);
          assert.doesNotMatch(String(original.error), /Desktop pairing was cancelled/i);
        }
        assert.equal(targetSignal?.aborted, true);
        assert.equal(counts.rendererPublication, 0);
        assert.equal(counts.ipcEntry, 1);
        assert.equal(counts.ipcExit, 1);
        assert.equal(handlers.size, 0);
        assert.equal(windowDestroyed, true);
        assert.equal(shutdownFinished, true);
        assert.equal(finalQuitCalls, 1);
        assert.equal(allowedFinalQuits, 1);
        assert.equal(activationFailures, scenario.endpoint === 'cancel' ? 2 : 0);
        for (const step of [
          'shutdown-started', 'ipc-close', 'session-close', 'protocol-dispose',
          'credentials-dispose', 'lifecycle-shutdown', 'ipc-drain', 'profiles-close',
          'session-dispose', 'ipc-dispose', 'window-destroy', 'app-quit',
        ]) {
          assert.equal(order.filter(entry => entry === step).length, 1, `${step} ran more than once`);
        }
        assert.equal(order.indexOf('profiles-close') > order.indexOf('ipc-drain'), true);
        assert.equal(order.indexOf('session-dispose') > order.indexOf('profiles-close'), true);
        assert.equal(order.indexOf('window-destroy') > order.indexOf('ipc-dispose'), true);
        assert.equal(order.at(-1), 'app-quit');
        await bounded(service.awaitIdle());
        await bounded(registered.awaitIdle());
        assert.deepEqual(service.prepareRequest(`${origin}/api/tasks`, {}), { cancel: true });
        assert.equal(clock.pending, 0);

        let extraQuitPrevented = false;
        shutdown.beforeQuit({ preventDefault: () => { extraQuitPrevented = true; } });
        assert.equal(extraQuitPrevented, true, 'more than the deliberate final quit was allowed');
        assert.equal(finalQuitCalls, 1);
        assert.equal(allowedFinalQuits, 1);

        const countsAtDispose = { ...counts };
        const bytesAtDispose = await durableBytes(directory);
        if (scenario.phase === 'header') lateHeader.reject(new Error('late private header failure'));
        if (cancellationCanSettle) lateCancellation.reject(new Error('late private cancellation failure'));
        await clock.advance(2_000);
        await immediate();
        await immediate();

        assert.deepEqual(counts, countsAtDispose);
        assert.deepEqual(await durableBytes(directory), bytesAtDispose);
        assert.deepEqual(unhandled, []);
        assert.equal(clock.pending, 0);
        console.log(`NATIVE_PAIRING_SHUTDOWN ${scenario.name}`);
      } finally {
        process.removeListener('unhandledRejection', onUnhandled);
        await service?.dispose().catch(() => undefined);
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
});
