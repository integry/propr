import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, it } from 'node:test';
import { completeDesktopPairing, ProprClient, ProprClientError } from '../src/index.js';
import { requestPairingProtocol, type PairingProtocolRequestOptions } from '../src/pairingProtocol.js';

const protocolNow = Date.parse('2026-01-01T00:00:00.000Z');
const deadline = new Date(protocolNow + 60_000).toISOString();
const pairingId = `dpr_${'P'.repeat(22)}`;
const deviceSecret = 'D'.repeat(43);
const activationTicket = 'A'.repeat(43);
const token = `propr_it_${'T'.repeat(43)}`;
const binding = {
  instanceId: 'profile-transport',
  origin: 'https://propr.example.test',
  scope: 'desktop-instance' as const,
  credentialGeneration: 'G'.repeat(22),
};
const completedPairing = {
  token,
  tokenType: 'Bearer' as const,
  pairingId,
  deviceSecret,
  activationTicket,
  activationExpiresAt: deadline,
  ...binding,
};

type EndpointName = 'start' | 'poll' | 'activate' | 'cancel';

const successBody = (endpoint: EndpointName, origin = binding.origin): Record<string, unknown> => {
  if (endpoint === 'start') return {
    pairingId,
    deviceSecret,
    approvalUrl: `${origin}/api/desktop/pairings/${pairingId}/browser`,
    expiresAt: deadline,
    interval: 1,
  };
  if (endpoint === 'poll') return {
    status: 'provisional',
    token,
    tokenType: 'Bearer',
    activationTicket,
    activationExpiresAt: deadline,
    ...binding,
    origin,
  };
  if (endpoint === 'activate') return {
    status: 'active',
    receipt: 'R'.repeat(22),
    activatedAt: '2026-01-01T00:00:01.000Z',
    expiresAt: null,
  };
  return { status: 'cancelled', cancelledAt: '2026-01-01T00:00:01.000Z' };
};

const jsonResponse = (
  value: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response => new Response(JSON.stringify(value), {
  status,
  headers: { 'Content-Type': 'application/json', ...headers },
});

const streamResponse = (
  chunks: Uint8Array[],
  options: { status?: number; headers?: Record<string, string>; error?: Error } = {},
): Response => new Response(new ReadableStream<Uint8Array>({
  start(controller) {
    chunks.forEach(chunk => controller.enqueue(chunk));
    if (options.error) controller.error(options.error);
    else controller.close();
  },
}), {
  status: options.status ?? 200,
  headers: { 'Content-Type': 'application/json', ...options.headers },
});

const runEndpoint = async (
  endpoint: EndpointName,
  fetchImplementation: typeof globalThis.fetch,
  signal?: AbortSignal,
  baseUrl = binding.origin,
): Promise<unknown> => {
  const client = new ProprClient({
    baseUrl,
    authentication: { type: 'none' },
    fetch: fetchImplementation,
  });
  if (endpoint === 'start') {
    return client.startDesktopPairing('Transport test', {
      signal,
      now: () => protocolNow,
      binding: { ...binding, origin: baseUrl },
    });
  }
  const pairing = { ...completedPairing, origin: baseUrl };
  if (endpoint === 'activate') return client.activateDesktopPairing(pairing, signal);
  if (endpoint === 'cancel') return client.cancelDesktopPairing(pairing, signal);
  return completeDesktopPairing(client, {
    pairingId,
    deviceSecret,
    approvalUrl: `${baseUrl}/approve`,
    expiresAt: deadline,
    interval: 1,
  }, {
    signal,
    now: () => protocolNow,
    sleep: async () => undefined,
    binding: { ...binding, origin: baseUrl },
  });
};

const bounded = async <T>(promise: Promise<T>, milliseconds = 1_000): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('transport operation did not settle')), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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

  get now(): number { return this.#now; }
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

const protocolRequest = (
  path: EndpointName,
  fetchImplementation: typeof globalThis.fetch,
  clock: ProtocolClock,
  options: Omit<PairingProtocolRequestOptions, 'clock'> = {},
): Promise<unknown> => requestPairingProtocol(
  fetchImplementation,
  `https://propr.example.test/${path}`,
  { method: 'POST' },
  { ...options, clock: clock.source },
);

const timeoutKind = (error: unknown): boolean =>
  error instanceof ProprClientError && error.kind === 'timeout';

describe('bounded pairing protocol response transport', () => {
  for (const endpoint of ['start', 'poll', 'activate', 'cancel'] as const) {
    it(`${endpoint} accepts exact-limit and absent-length bodies but rejects deceptive Content-Length`, async () => {
      const json = JSON.stringify(successBody(endpoint));
      const exact = new TextEncoder().encode(json + ' '.repeat(4_096 - Buffer.byteLength(json)));
      assert.equal(exact.byteLength, 4_096);
      await runEndpoint(endpoint, async () => streamResponse([
        exact.slice(0, 1),
        exact.slice(1, 2_049),
        exact.slice(2_049),
      ]));
      await assert.rejects(runEndpoint(endpoint, async () => streamResponse([
        new TextEncoder().encode(json),
      ], { headers: { 'Content-Length': '1' } })), (error: unknown) =>
        error instanceof ProprClientError && error.kind === 'invalid_response');
    });

    it(`${endpoint} cancels over-limit, stalled, malformed, errored, and late-extra bodies`, async () => {
      const valid = JSON.stringify(successBody(endpoint));
      const over = new TextEncoder().encode(valid + ' '.repeat(4_097 - Buffer.byteLength(valid)));
      let cancelled = 0;
      const failures: Array<() => Promise<unknown>> = [
        () => runEndpoint(endpoint, async () => streamResponse([over.slice(0, 4_096), over.slice(4_096)])),
        () => runEndpoint(endpoint, async () => streamResponse([new Uint8Array([0xff])])),
        () => runEndpoint(endpoint, async () => jsonResponse({ broken: true })),
        () => runEndpoint(endpoint, async () => streamResponse([
          new TextEncoder().encode(valid),
          new TextEncoder().encode('{"late":true}'),
        ])),
        () => runEndpoint(endpoint, async () => streamResponse([
          new TextEncoder().encode(valid.slice(0, 2)),
        ], { error: new Error('private premature stream detail') })),
      ];
      for (const failure of failures) {
        await assert.rejects(bounded(failure()), (error: unknown) =>
          error instanceof ProprClientError
          && ['invalid_response', 'network'].includes(error.kind)
          && !error.message.includes('private'));
      }

      const controller = new AbortController();
      let bodyStarted!: () => void;
      const started = new Promise<void>(resolve => { bodyStarted = resolve; });
      let streamCancelled = false;
      const stalled = runEndpoint(endpoint, async () => new Response(new ReadableStream<Uint8Array>({
        start(streamController) {
          setImmediate(() => {
            if (!streamCancelled) streamController.enqueue(new TextEncoder().encode('{'));
            bodyStarted();
          });
        },
        cancel() { streamCancelled = true; cancelled += 1; },
      }), { headers: { 'Content-Type': 'application/json' } }), controller.signal);
      await started;
      controller.abort('caller stopped operation');
      await assert.rejects(bounded(stalled), (error: unknown) =>
        error instanceof ProprClientError && error.kind === 'aborted');
      assert.equal(cancelled, 1);
    });

    it(`${endpoint} aborts a headers stall and redacts empty or HTML HTTP errors`, async () => {
      const controller = new AbortController();
      let headerStarted!: () => void;
      const started = new Promise<void>(resolve => { headerStarted = resolve; });
      const stalled = runEndpoint(endpoint, async (_input, init) => new Promise<Response>((_resolve, reject) => {
        headerStarted();
        init?.signal?.addEventListener('abort', () => reject(new DOMException('secret', 'AbortError')), { once: true });
      }), controller.signal);
      await started;
      controller.abort();
      await assert.rejects(bounded(stalled), (error: unknown) =>
        error instanceof ProprClientError && error.kind === 'aborted');

      for (const response of [
        new Response(null, { status: 502 }),
        new Response('<h1>private upstream detail</h1>', {
          status: 502,
          headers: { 'Content-Type': 'text/html' },
        }),
        new Response('{', { status: 502, headers: { 'Content-Type': 'application/json' } }),
      ]) {
        await assert.rejects(runEndpoint(endpoint, async () => response), (error: unknown) =>
          error instanceof ProprClientError
          && error.kind === 'http'
          && error.status === 502
          && error.code === undefined
          && !error.message.includes('private'));
      }
    });
  }

  for (const endpoint of ['start', 'poll', 'activate', 'cancel'] as const) {
    it(`${endpoint} enforces automatic header, body, slowloris, and overall deadlines`, async () => {
      {
        const clock = new ProtocolClock();
        let networkSignal: AbortSignal | undefined;
        const operation = protocolRequest(endpoint, async (_input, init) => {
          networkSignal = init?.signal ?? undefined;
          return new Promise<Response>(() => undefined);
        }, clock, {
          overallTimeoutMs: 40,
          deadlines: { headerMs: 10, bodyMs: 10, cancellationMs: 5 },
        });
        await clock.advance(9);
        assert.equal(networkSignal?.aborted, false);
        await clock.advance(1);
        await assert.rejects(operation, timeoutKind);
        assert.equal(networkSignal?.aborted, true);
        assert.equal(clock.pending, 0);
      }

      for (const firstChunk of [undefined, new Uint8Array([0x7b])]) {
        const clock = new ProtocolClock();
        let networkSignal: AbortSignal | undefined;
        let cancelled = 0;
        const operation = protocolRequest(endpoint, async (_input, init) => {
          networkSignal = init?.signal ?? undefined;
          return new Response(new ReadableStream<Uint8Array>({
            start(controller) { if (firstChunk) controller.enqueue(firstChunk); },
            cancel() { cancelled += 1; },
          }), { headers: { 'Content-Type': 'application/json' } });
        }, clock, {
          overallTimeoutMs: 40,
          deadlines: { headerMs: 20, bodyMs: 10, cancellationMs: 5 },
        });
        await clock.advance(0);
        await clock.advance(10);
        await assert.rejects(operation, timeoutKind);
        assert.equal(networkSignal?.aborted, true);
        assert.equal(cancelled, 1);
        assert.equal(clock.pending, 0);
      }

      {
        const clock = new ProtocolClock();
        let networkSignal: AbortSignal | undefined;
        const operation = protocolRequest(endpoint, async (_input, init) => {
          networkSignal = init?.signal ?? undefined;
          return new Promise<Response>(() => undefined);
        }, clock, {
          overallTimeoutMs: 10,
          deadlines: { headerMs: 20, bodyMs: 20, cancellationMs: 5 },
        });
        await clock.advance(10);
        await assert.rejects(operation, timeoutKind);
        assert.equal(networkSignal?.aborted, true);
        assert.equal(clock.pending, 0);
      }
    });

    it(`${endpoint} bounds never-settling reader cancellation and ignores every late callback`, async () => {
      const clock = new ProtocolClock();
      let networkSignal: AbortSignal | undefined;
      let cancelReject!: (error: Error) => void;
      const cancellation = new Promise<void>((_resolve, reject) => { cancelReject = reject; });
      let cancelCalls = 0;
      const diagnostics: string[] = [];
      const unhandled: unknown[] = [];
      const onUnhandled = (error: unknown): void => { unhandled.push(error); };
      process.on('unhandledRejection', onUnhandled);
      try {
        const operation = protocolRequest(endpoint, async (_input, init) => {
          networkSignal = init?.signal ?? undefined;
          return new Response(new ReadableStream<Uint8Array>({
            cancel() {
              cancelCalls += 1;
              return cancellation;
            },
          }), { headers: { 'Content-Type': 'application/json' } });
        }, clock, {
          overallTimeoutMs: 40,
          deadlines: { headerMs: 20, bodyMs: 10, cancellationMs: 5 },
          reportDiagnostic: message => { diagnostics.push(message); },
        });
        await clock.advance(0);
        await clock.advance(10);
        assert.equal(clock.pending, 1);
        await clock.advance(5);
        await assert.rejects(operation, timeoutKind);
        assert.equal(networkSignal?.aborted, true);
        assert.equal(cancelCalls, 1);
        assert.deepEqual(diagnostics, [
          'ProPR pairing response cancellation exceeded its fixed deadline.',
        ]);
        assert.equal(clock.pending, 0);

        cancelReject(new Error('private late cancellation failure'));
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(cancelCalls, 1);
        assert.equal(clock.pending, 0);
        assert.equal(diagnostics.length, 1);
        assert.deepEqual(unhandled, []);
      } finally {
        process.removeListener('unhandledRejection', onUnhandled);
      }
    });
  }

  it('bounds a never-settling response.body.cancel before a reader exists', async () => {
    const clock = new ProtocolClock();
    let networkSignal: AbortSignal | undefined;
    let rejectCancellation!: (error: Error) => void;
    const diagnostics: string[] = [];
    const response = new Response(new ReadableStream<Uint8Array>({
      cancel() {
        return new Promise<void>((_resolve, reject) => { rejectCancellation = reject; });
      },
    }), {
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': '4097',
      },
    });
    const operation = protocolRequest('activate', async (_input, init) => {
      networkSignal = init?.signal ?? undefined;
      return response;
    }, clock, {
      overallTimeoutMs: 40,
      deadlines: { headerMs: 20, bodyMs: 20, cancellationMs: 5 },
      reportDiagnostic: message => { diagnostics.push(message); },
    });
    await clock.advance(0);
    assert.equal(clock.pending, 1);
    await clock.advance(5);
    await assert.rejects(operation, (error: unknown) =>
      error instanceof ProprClientError && error.kind === 'invalid_response');
    assert.equal(networkSignal?.aborted, true);
    assert.equal(clock.pending, 0);
    assert.equal(diagnostics.length, 1);
    rejectCancellation(new Error('private late body cancellation failure'));
    await new Promise<void>(resolve => setImmediate(resolve));
  });

  it('makes exact header, body, overall, and cancellation boundaries terminal', async () => {
    {
      const clock = new ProtocolClock();
      let signal: AbortSignal | undefined;
      const operation = protocolRequest('start', async (_input, init) => {
        signal = init?.signal ?? undefined;
        return new Promise<Response>(resolve => {
          clock.source.setTimeout(() => resolve(jsonResponse(successBody('start'))), 10);
        });
      }, clock, {
        overallTimeoutMs: 40,
        deadlines: { headerMs: 10, bodyMs: 20, cancellationMs: 5 },
      });
      await clock.advance(10);
      await assert.rejects(operation, timeoutKind);
      assert.equal(signal?.aborted, true);
      assert.equal(clock.pending, 0);
    }

    for (const overallWins of [false, true]) {
      const clock = new ProtocolClock();
      let signal: AbortSignal | undefined;
      let bodyController!: ReadableStreamDefaultController<Uint8Array>;
      const operation = protocolRequest('activate', async (_input, init) => {
        signal = init?.signal ?? undefined;
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) { bodyController = controller; },
        }), { headers: { 'Content-Type': 'application/json' } });
      }, clock, {
        overallTimeoutMs: overallWins ? 10 : 40,
        deadlines: { headerMs: 20, bodyMs: overallWins ? 20 : 10, cancellationMs: 5 },
      });
      await clock.advance(0);
      clock.source.setTimeout(() => {
        if (signal?.aborted) return;
        bodyController.enqueue(new TextEncoder().encode(JSON.stringify(successBody('activate'))));
        bodyController.close();
      }, 10);
      await clock.advance(10);
      await assert.rejects(operation, timeoutKind);
      assert.equal(signal?.aborted, true);
      assert.equal(clock.pending, 0);
    }

    {
      const clock = new ProtocolClock();
      const diagnostics: string[] = [];
      const operation = protocolRequest('cancel', async () => new Response(
        new ReadableStream<Uint8Array>({ cancel: () => new Promise<void>(() => undefined) }),
        { headers: { 'Content-Type': 'application/json' } },
      ), clock, {
        overallTimeoutMs: 10,
        deadlines: { headerMs: 20, bodyMs: 8, cancellationMs: 5 },
        reportDiagnostic: message => { diagnostics.push(message); },
      });
      await clock.advance(0);
      await clock.advance(8);
      assert.equal(clock.pending, 1);
      await clock.advance(2);
      await assert.rejects(operation, timeoutKind);
      assert.equal(clock.now, 10);
      assert.equal(clock.pending, 0);
      assert.equal(diagnostics.length, 1);
    }
  });
});

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  })));
});

const listen = async (handler: Parameters<typeof createServer>[0]): Promise<{ server: Server; origin: string }> => {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  return { server, origin: `http://127.0.0.1:${address.port}` };
};

describe('pairing redirect fencing', () => {
  it('never replays any pairing endpoint across origins on 307 or 308', async () => {
    const received: string[] = [];
    const receiver = await listen((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', chunk => { body += String(chunk); });
      request.on('end', () => {
        received.push(`${request.url}\n${JSON.stringify(request.headers)}\n${body}`);
        response.end();
      });
    });
    let redirectStatus = 307;
    const source = await listen((_request, response) => {
      response.writeHead(redirectStatus, { Location: `${receiver.origin}/captured` });
      response.end();
    });

    for (redirectStatus of [307, 308]) {
      for (const endpoint of ['start', 'poll', 'activate', 'cancel'] as const) {
        await assert.rejects(runEndpoint(endpoint, globalThis.fetch, undefined, source.origin), (error: unknown) =>
          error instanceof ProprClientError && error.kind === 'invalid_response');
      }
    }
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(received, []);
    const receiverDump = received.join('\n');
    for (const material of [deviceSecret, pairingId, activationTicket, token, 'Bearer', binding.instanceId]) {
      assert.equal(receiverDump.includes(material), false);
    }
  });

  it('rejects absolute, relative, missing, and looping same-origin redirects without replay', async () => {
    let requests = 0;
    let location: string | undefined;
    let origin = '';
    const source = await listen((_request, response) => {
      requests += 1;
      const headers = location === undefined ? {} : { Location: location };
      response.writeHead(307, headers);
      response.end();
    });
    origin = source.origin;

    for (const nextLocation of [`${origin}/absolute`, '/relative', undefined, '/loop']) {
      location = nextLocation;
      const before = requests;
      await assert.rejects(runEndpoint('activate', globalThis.fetch, undefined, origin), (error: unknown) =>
        error instanceof ProprClientError && error.kind === 'invalid_response');
      assert.equal(requests, before + 1);
    }
  });
});
