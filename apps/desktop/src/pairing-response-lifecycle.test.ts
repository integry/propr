import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { DesktopCredentialService } from './credential-service';
import { ProfileStore, type EncryptionProvider } from './profile-store';

const encryption: EncryptionProvider = {
  isEncryptionAvailable: () => true,
  backend: () => 'keychain',
  encrypt: value => Buffer.from(value, 'utf8'),
  decrypt: value => value.toString('utf8'),
};
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(settle => { resolve = settle; });
  return { promise, resolve };
};

it('dispose drains a headers-then-stall activation body before retaining provisional rollback', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'propr-pairing-response-'));
  const store = new ProfileStore(directory, encryption);
  const profile = await store.save({
    id: 'profile-pair-activation-stall',
    label: 'Activation stall',
    apiBaseUrl: 'https://a.example.test',
  });
  const pairingNow = Date.parse('2026-01-01T00:00:00.000Z');
  const expiresAt = new Date(pairingNow + 10_000).toISOString();
  const activationBodyStarted = deferred<void>();
  let activationBodyCancelled = false;
  let networkCalls = 0;
  let streamCancelled = false;
  let pairingBinding: Record<string, unknown> = {};
  const service = new DesktopCredentialService({
    profiles: store,
    clientName: 'Activation response lifecycle test',
    openExternal: async () => undefined,
    pairingTiming: { now: () => pairingNow, sleep: async () => undefined },
    fetch: async (input, init) => {
      networkCalls += 1;
      const url = input.toString();
      if (url.endsWith('/api/desktop/pairings')) {
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
          approvalUrl: 'https://a.example.test/approve',
          expiresAt,
          interval: 1,
        }, 201);
      }
      if (url.endsWith('/poll')) return json({
        status: 'provisional',
        token: `propr_it_${'C'.repeat(43)}`,
        tokenType: 'Bearer',
        activationTicket: 'T'.repeat(43),
        activationExpiresAt: expiresAt,
        ...pairingBinding,
      });
      if (url.endsWith('/activate')) {
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            setImmediate(() => {
              if (!streamCancelled) controller.enqueue(new TextEncoder().encode('{'));
              activationBodyStarted.resolve();
            });
          },
          cancel() {
            streamCancelled = true;
            activationBodyCancelled = true;
          },
        }), { headers: { 'Content-Type': 'application/json' } });
      }
      throw new Error(`Unexpected post-dispose request: ${url}`);
    },
  });

  try {
    const pairing = service.pair({
      id: profile.id,
      label: profile.label,
      apiBaseUrl: profile.apiBaseUrl,
    });
    await activationBodyStarted.promise;
    let disposalTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        service.dispose(),
        new Promise<never>((_resolve, reject) => {
          disposalTimer = setTimeout(
            () => reject(new Error('Credential service disposal did not drain activation')),
            1_000,
          );
        }),
      ]);
    } finally {
      if (disposalTimer) clearTimeout(disposalTimer);
    }
    await assert.rejects(pairing, /cancelled/i);
    const callsAtDispose = networkCalls;
    await new Promise(resolve => setTimeout(resolve, 20));

    const pending = await store.pendingRevocations();
    assert.equal(activationBodyCancelled, true);
    assert.equal(networkCalls, callsAtDispose);
    assert.equal(pending.length, 1);
    assert.deepEqual(pending[0].credential, {
      version: 1,
      profileId: profile.id,
      origin: profile.apiBaseUrl,
      token: `propr_it_${'C'.repeat(43)}`,
    });
    assert.equal(await store.readCredential(profile.id), null);
  } finally {
    await service.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
