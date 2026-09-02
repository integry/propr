import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PROPR_API_COMPATIBILITY, PROPR_UI_COMPATIBILITY } from '@propr/shared';
import { ProprClient, ProprClientError } from '../src/index.js';

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

const discovery = {
  schemaVersion: 1 as const,
  product: 'ProPR',
  version: '0.8.15',
  apiCompatibility: PROPR_API_COMPATIBILITY,
  uiCompatibility: PROPR_UI_COMPATIBILITY,
  canonicalEndpoint: null,
  publicInstanceIdentity: '123e4567-e89b-42d3-a456-426614174000',
  desktopAuthentication: {
    protocolVersion: 2 as const,
    browserPairing: true,
    instanceBearerTokens: true,
    socketIoBearerAuthentication: true,
  },
};
const protocolNow = Date.parse('2026-01-01T00:00:00.000Z');
const protocolDeadline = new Date(protocolNow + 10 * 60 * 1000).toISOString();
const binding = {
  instanceId: 'profile-a',
  origin: 'https://propr.example.test',
  scope: 'desktop-instance' as const,
  credentialGeneration: 'G'.repeat(22),
};
const bounded = <T>(promise: Promise<T>, milliseconds = 1_000): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Pairing did not settle within the test timeout')), milliseconds);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
};

class PairingClock {
  #now = 0;
  #nextId = 1;
  readonly #timers = new Map<number, { at: number; callback: () => void }>();

  readonly source = {
    now: (): number => this.#now,
    setTimeout: (callback: () => void, milliseconds: number): ReturnType<typeof setTimeout> => {
      const id = this.#nextId++;
      this.#timers.set(id, { at: this.#now + milliseconds, callback });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: (timer: ReturnType<typeof setTimeout>): void => {
      this.#timers.delete(timer as unknown as number);
    },
  };

  async advanceAfterSchedulerDelay(milliseconds: number): Promise<void> {
    this.#now += milliseconds;
    while (true) {
      const due = [...this.#timers.entries()]
        .filter(([, timer]) => timer.at <= this.#now)
        .sort(([leftId, left], [rightId, right]) => left.at - right.at || leftId - rightId)[0];
      if (!due) break;
      this.#timers.delete(due[0]);
      due[1].callback();
      await Promise.resolve();
      await Promise.resolve();
    }
  }
}

describe('desktop instance protocol', () => {
  it('uses the shared strict wire parser for missing, extra, malformed, duplicate, and oversized discovery', async () => {
    const valid = JSON.stringify(discovery);
    const invalidBodies = [
      JSON.stringify((({ publicInstanceIdentity: _omitted, ...rest }) => rest)(discovery)),
      JSON.stringify({ ...discovery, account: 'must-not-be-present' }),
      '{',
      valid.replace('"product":"ProPR"', '"product":"ProPR","product":"ProPR"'),
      `${valid}${' '.repeat(8 * 1024)}`,
      JSON.stringify({ ...discovery, publicInstanceIdentity: discovery.publicInstanceIdentity.toUpperCase() }),
      JSON.stringify({ ...discovery, desktopAuthentication: {
        ...discovery.desktopAuthentication, protocolVersion: 1,
      } }),
    ];
    for (const body of invalidBodies) {
      const client = new ProprClient({
        baseUrl: 'https://propr.example.test',
        authentication: { type: 'none' },
        fetch: async () => new Response(body, { headers: { 'Content-Type': 'application/json' } }),
      });
      await assert.rejects(client.discoverDesktop(), (error: unknown) =>
        error instanceof ProprClientError && error.kind === 'invalid_response');
    }
  });

  it('discovers capabilities, opens approval, and polls to a single opaque token', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    let polls = 0;
    const client = new ProprClient({
      baseUrl: 'https://propr.example.test',
      authentication: { type: 'none' },
      fetch: async (input, init) => {
        const url = input.toString();
        requests.push({ url, init });
        if (url.endsWith('/api/desktop/discovery')) return json(discovery);
        if (url.endsWith('/api/desktop/pairings')) return json({
          pairingId: `dpr_${'A'.repeat(22)}`,
          deviceSecret: 'B'.repeat(43),
          approvalUrl: `https://propr.example.test/api/desktop/pairings/dpr_${'A'.repeat(22)}/browser`,
          expiresAt: protocolDeadline,
          interval: 2,
        }, 201);
        polls += 1;
        return polls === 1
          ? json({ status: 'pending', interval: 3 }, 202)
          : json({
            status: 'provisional',
            token: `propr_it_${'C'.repeat(43)}`,
            tokenType: 'Bearer',
            activationTicket: 'T'.repeat(43),
            activationExpiresAt: protocolDeadline,
            ...binding,
          });
      },
    });

    const metadata = await client.discoverDesktop();
    assert.equal(metadata.compatibility.compatible, true);
    assert.equal(metadata.desktopAuthentication.browserPairing, true);

    const opened: string[] = [];
    const sleeps: number[] = [];
    const complete = await client.pairDesktop('Test desktop', {
      binding,
      now: () => protocolNow,
      sleep: async milliseconds => { sleeps.push(milliseconds); },
      onApprovalRequired: url => { opened.push(url); },
    });

    assert.deepEqual(complete, {
      token: `propr_it_${'C'.repeat(43)}`,
      tokenType: 'Bearer',
      pairingId: `dpr_${'A'.repeat(22)}`,
      deviceSecret: 'B'.repeat(43),
      activationTicket: 'T'.repeat(43),
      activationExpiresAt: protocolDeadline,
      ...binding,
    });
    assert.deepEqual(opened, [`https://propr.example.test/api/desktop/pairings/dpr_${'A'.repeat(22)}/browser`]);
    assert.deepEqual(sleeps, [2000, 3000]);
    assert.equal(requests.every(request => !request.url.includes('B'.repeat(43))), true);
    assert.equal(requests.filter(request => request.url.endsWith('/poll')).every(request =>
      String(request.init?.body).includes('B'.repeat(43))), true);
  });

  it('cancels and expires without another poll request', async () => {
    const client = new ProprClient({ fetch: async () => { throw new Error('must not request'); } });
    const start = {
      pairingId: `dpr_${'A'.repeat(22)}`,
      deviceSecret: 'B'.repeat(43),
      approvalUrl: 'https://propr.example.test/approve',
      expiresAt: '2026-01-01T00:00:00.000Z',
      interval: 1,
    };
    await assert.rejects(
      // Importing through the client keeps the public helper covered separately
      // from the start endpoint.
      import('../src/index.js').then(({ completeDesktopPairing }) => completeDesktopPairing(client, start, {
        now: () => Date.parse('2026-01-01T00:00:00.000Z'),
      })),
      (error: unknown) => error instanceof ProprClientError && error.code === 'PAIRING_EXPIRED',
    );

    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      import('../src/index.js').then(({ completeDesktopPairing }) => completeDesktopPairing(client, {
        ...start,
        expiresAt: protocolDeadline,
      }, { signal: controller.signal })),
      (error: unknown) => error instanceof ProprClientError && error.kind === 'aborted',
    );
  });

  it('expires while the approval callback is still pending and ignores its late completion', async () => {
    const { completeDesktopPairing } = await import('../src/index.js');
    let finishApproval!: () => void;
    let polls = 0;
    const approvalStarted = new Promise<void>(resolve => { finishApproval = resolve; });
    let completeApproval!: () => void;
    const client = new ProprClient({ fetch: async () => {
      polls += 1;
      throw new Error('must not poll after approval expiry');
    } });
    const pairing = completeDesktopPairing(client, {
      pairingId: `dpr_${'A'.repeat(22)}`,
      deviceSecret: 'B'.repeat(43),
      approvalUrl: 'https://propr.example.test/approve',
      expiresAt: new Date(Date.now() + 50).toISOString(),
      interval: 1,
    }, {
      onApprovalRequired: () => new Promise<void>(resolve => {
        completeApproval = resolve;
        finishApproval();
      }),
    });

    await approvalStarted;
    await assert.rejects(bounded(pairing), (error: unknown) =>
      error instanceof ProprClientError && error.code === 'PAIRING_EXPIRED');
    completeApproval();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(polls, 0);
  });

  it('aborts while the approval callback is pending and handles a late callback rejection', async () => {
    const { completeDesktopPairing } = await import('../src/index.js');
    const controller = new AbortController();
    let approvalStarted!: () => void;
    const started = new Promise<void>(resolve => { approvalStarted = resolve; });
    let rejectApproval!: (error: Error) => void;
    const client = new ProprClient({ fetch: async () => { throw new Error('must not poll'); } });
    const pairing = completeDesktopPairing(client, {
      pairingId: `dpr_${'A'.repeat(22)}`,
      deviceSecret: 'B'.repeat(43),
      approvalUrl: 'https://propr.example.test/approve',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      interval: 1,
    }, {
      signal: controller.signal,
      onApprovalRequired: () => new Promise<void>((_resolve, reject) => {
        rejectApproval = reject;
        approvalStarted();
      }),
    });

    await started;
    controller.abort('test cancellation');
    await assert.rejects(bounded(pairing), (error: unknown) =>
      error instanceof ProprClientError && error.kind === 'aborted');
    rejectApproval(new Error('late approval failure'));
    await new Promise<void>(resolve => setImmediate(resolve));
  });

  it('rejects an unsafe approval URL', async () => {
    const client = new ProprClient({
      baseUrl: 'https://propr.example.test',
      fetch: async () => json({
        pairingId: `dpr_${'A'.repeat(22)}`,
        deviceSecret: 'B'.repeat(43),
        approvalUrl: 'http://remote.example.test/approve',
        expiresAt: protocolDeadline,
        interval: 2,
      }, 201),
    });
    await assert.rejects(client.startDesktopPairing('Desktop', { now: () => protocolNow }), (error: unknown) =>
      error instanceof ProprClientError && error.kind === 'invalid_response');
  });

  it('enforces the browser request origin for same-origin pairing clients', async () => {
    const locationDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'location');
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      value: { origin: 'https://propr.example.test' },
    });
    try {
      for (const [approvalUrl, accepted] of [
        ['https://propr.example.test/approve', true],
        ['https://attacker.example.test/approve', false],
      ] as const) {
        const client = new ProprClient({
          fetch: async () => json({
            pairingId: `dpr_${'A'.repeat(22)}`,
            deviceSecret: 'B'.repeat(43),
            approvalUrl,
            expiresAt: protocolDeadline,
            interval: 2,
          }, 201),
        });
        if (accepted) {
          await assert.doesNotReject(client.startDesktopPairing('Desktop', { now: () => protocolNow }));
        } else {
          await assert.rejects(
            client.startDesktopPairing('Desktop', { now: () => protocolNow }),
            (error: unknown) => error instanceof ProprClientError && error.kind === 'invalid_response',
          );
        }
      }
    } finally {
      if (locationDescriptor) Object.defineProperty(globalThis, 'location', locationDescriptor);
      else Reflect.deleteProperty(globalThis, 'location');
    }
  });

  it('fails closed before pairing when a same-origin request has no browser origin', async () => {
    const locationDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'location');
    Reflect.deleteProperty(globalThis, 'location');
    let requests = 0;
    try {
      const client = new ProprClient({ fetch: async () => {
        requests += 1;
        throw new Error('must not request without a trusted origin');
      } });
      await assert.rejects(
        client.startDesktopPairing('Desktop', { now: () => protocolNow }),
        (error: unknown) => error instanceof ProprClientError && error.kind === 'configuration',
      );
      assert.equal(requests, 0);
    } finally {
      if (locationDescriptor) Object.defineProperty(globalThis, 'location', locationDescriptor);
    }
  });

  it('rejects cross-origin, credentialed, malformed, and invalid-deadline approval responses', async () => {
    for (const override of [
      { approvalUrl: 'https://attacker.example.test/approve' },
      { approvalUrl: 'https://user:secret@propr.example.test/approve' },
      { approvalUrl: 'not a URL' },
      { expiresAt: 'not a deadline' },
    ]) {
      const client = new ProprClient({
        baseUrl: 'https://propr.example.test',
        fetch: async () => json({
          pairingId: `dpr_${'A'.repeat(22)}`,
          deviceSecret: 'B'.repeat(43),
          approvalUrl: 'https://propr.example.test/approve',
          expiresAt: protocolDeadline,
          interval: 2,
          ...override,
        }, 201),
      });
      await assert.rejects(client.startDesktopPairing('Desktop', { now: () => protocolNow }), (error: unknown) =>
        error instanceof ProprClientError && error.kind === 'invalid_response');
    }
  });

  it('cancels while the pairing start request is in flight', async () => {
    const controller = new AbortController();
    let started!: () => void;
    const requestStarted = new Promise<void>(resolve => { started = resolve; });
    const client = new ProprClient({
      baseUrl: 'https://propr.example.test',
      fetch: async (_input, init) => new Promise<Response>((_resolve, reject) => {
        started();
        init?.signal?.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true });
      }),
    });

    const pairing = client.pairDesktop('Desktop', { signal: controller.signal });
    await requestStarted;
    controller.abort();
    await assert.rejects(pairing, (error: unknown) =>
      error instanceof ProprClientError && error.kind === 'aborted');
  });

  it('aborts a hung poll at the advertised deadline and reports expiry', async () => {
    const expiresAt = new Date(protocolNow + 40).toISOString();
    const sleeps: number[] = [];
    const client = new ProprClient({
      baseUrl: 'https://propr.example.test',
      fetch: async (input, init) => {
        if (input.toString().endsWith('/api/desktop/pairings')) return json({
          pairingId: `dpr_${'A'.repeat(22)}`,
          deviceSecret: 'B'.repeat(43),
          approvalUrl: 'https://propr.example.test/approve',
          expiresAt,
          interval: 1,
        }, 201);
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('expired', 'AbortError')), { once: true });
        });
      },
    });

    await assert.rejects(client.pairDesktop('Desktop', {
      now: () => protocolNow,
      sleep: async milliseconds => { sleeps.push(milliseconds); },
    }), (error: unknown) =>
      error instanceof ProprClientError && error.code === 'PAIRING_EXPIRED');
    assert.deepEqual(sleeps, [40]);
  });

  for (const lateSettlement of ['microtask', 'next-task'] as const) {
    it(`expires when a scheduler-delayed token response settles in the ${lateSettlement}`, async () => {
      const { completeDesktopPairing } = await import('../src/index.js');
      const pairingClock = new PairingClock();
      const transportClock = new PairingClock();
      const expiresAt = new Date(protocolNow + 40).toISOString();
      let lateResponseResolved = false;
      let pollStarted!: () => void;
      const polling = new Promise<void>(resolve => { pollStarted = resolve; });
      const client = new ProprClient({
        baseUrl: 'https://propr.example.test',
        pairingProtocol: { clock: transportClock.source },
        fetch: async (_input, init) => new Promise<Response>(resolve => {
          pollStarted();
          init?.signal?.addEventListener('abort', () => {
            const settle = () => {
              lateResponseResolved = true;
              resolve(json({
                status: 'provisional',
                token: `propr_it_${'C'.repeat(43)}`,
                tokenType: 'Bearer',
                activationTicket: 'T'.repeat(43),
                activationExpiresAt: protocolDeadline,
                ...binding,
              }));
            };
            if (lateSettlement === 'microtask') queueMicrotask(settle);
            else setImmediate(settle);
          }, { once: true });
        }),
      });

      const pairing = completeDesktopPairing(client, {
        pairingId: `dpr_${'A'.repeat(22)}`,
        deviceSecret: 'B'.repeat(43),
        approvalUrl: 'https://propr.example.test/approve',
        expiresAt,
        interval: 1,
      }, {
        binding,
        clock: pairingClock.source,
        now: () => protocolNow + pairingClock.source.now(),
        sleep: async () => undefined,
      });

      await polling;
      // The transport scheduler reaches the shared boundary while the pairing
      // scheduler remains stalled. This deterministically reproduces hosted
      // load without relying on a real 40 ms timer race.
      await transportClock.advanceAfterSchedulerDelay(75);
      await assert.rejects(bounded(pairing), (error: unknown) =>
        error instanceof ProprClientError && error.code === 'PAIRING_EXPIRED');
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(lateResponseResolved, true);
    });
  }

  it('aborts an in-flight poll when the caller cancels', async () => {
    const controller = new AbortController();
    let pollStarted!: () => void;
    const polling = new Promise<void>(resolve => { pollStarted = resolve; });
    const client = new ProprClient({
      baseUrl: 'https://propr.example.test',
      fetch: async (input, init) => {
        if (input.toString().endsWith('/api/desktop/pairings')) return json({
          pairingId: `dpr_${'A'.repeat(22)}`,
          deviceSecret: 'B'.repeat(43),
          approvalUrl: 'https://propr.example.test/approve',
          expiresAt: protocolDeadline,
          interval: 1,
        }, 201);
        pollStarted();
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('cancelled', 'AbortError')),
            { once: true },
          );
        });
      },
    });

    const pairing = client.pairDesktop('Desktop', {
      signal: controller.signal,
      now: () => protocolNow,
      sleep: async () => undefined,
    });
    await polling;
    controller.abort();
    await assert.rejects(pairing, (error: unknown) =>
      error instanceof ProprClientError && error.kind === 'aborted');
  });

  it('rejects invalid start intervals and deadlines instead of scheduling them', async () => {
    const invalidOverrides: Array<Record<string, unknown>> = [
      { interval: 0 },
      { interval: 0.5 },
      { interval: 61 },
      { interval: Number.MAX_VALUE },
      { interval: Number.NaN },
      { interval: Number.POSITIVE_INFINITY },
      { expiresAt: 'not a deadline' },
      { expiresAt: new Date(protocolNow).toISOString() },
      { expiresAt: new Date(protocolNow + 30 * 60 * 1000 + 1).toISOString() },
    ];
    for (const override of invalidOverrides) {
      const client = new ProprClient({
        baseUrl: 'https://propr.example.test',
        fetch: async () => json({
          pairingId: `dpr_${'A'.repeat(22)}`,
          deviceSecret: 'B'.repeat(43),
          approvalUrl: 'https://propr.example.test/approve',
          expiresAt: protocolDeadline,
          interval: 2,
          ...override,
        }, 201),
      });
      await assert.rejects(
        client.startDesktopPairing('Desktop', { now: () => protocolNow }),
        (error: unknown) => error instanceof ProprClientError && error.kind === 'invalid_response',
      );
    }
  });

  it('rejects invalid intervals returned by every pending response', async () => {
    const { completeDesktopPairing } = await import('../src/index.js');
    const start = {
      pairingId: `dpr_${'A'.repeat(22)}`,
      deviceSecret: 'B'.repeat(43),
      approvalUrl: 'https://propr.example.test/approve',
      expiresAt: protocolDeadline,
      interval: 1,
    };
    for (const interval of [0, 0.5, 61, Number.MAX_VALUE, Number.NaN, Number.POSITIVE_INFINITY]) {
      const client = new ProprClient({
        fetch: async () => json({ status: 'pending', interval }, 202),
      });
      await assert.rejects(completeDesktopPairing(client, start, {
        now: () => protocolNow,
        sleep: async () => undefined,
      }), (error: unknown) => error instanceof ProprClientError && error.kind === 'invalid_response');
    }
  });

  it('clamps a valid polling interval to the remaining advertised deadline', async () => {
    const { completeDesktopPairing } = await import('../src/index.js');
    let now = protocolNow;
    const sleeps: number[] = [];
    const client = new ProprClient({ fetch: async () => { throw new Error('must not poll after deadline'); } });
    await assert.rejects(completeDesktopPairing(client, {
      pairingId: `dpr_${'A'.repeat(22)}`,
      deviceSecret: 'B'.repeat(43),
      approvalUrl: 'https://propr.example.test/approve',
      expiresAt: new Date(protocolNow + 500).toISOString(),
      interval: 60,
    }, {
      now: () => now,
      sleep: async milliseconds => {
        sleeps.push(milliseconds);
        now += milliseconds;
      },
    }), (error: unknown) => error instanceof ProprClientError && error.code === 'PAIRING_EXPIRED');
    assert.deepEqual(sleeps, [500]);
  });
});
