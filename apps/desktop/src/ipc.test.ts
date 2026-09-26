import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Session } from 'electron';
import { clearDesktopInstanceCookies, logoutDesktopSession } from './desktop-session';
import { isValidDesktopDeepLinkAcknowledgement } from './ipc';

describe('desktop session IPC operations', () => {
  it('accepts only acknowledgements semantically bound to the delivered deep link', () => {
    const connect = {
      deliveryId: 1,
      url: 'propr://connect?api=https%3A%2F%2Fconnect.propr.dev',
      consumption: { kind: 'connect-confirmation', target: 'https://connect.propr.dev' },
    };
    const open = {
      deliveryId: 2,
      url: 'propr://open?path=%2Ftasks%3Fstatus%3Dopen',
      consumption: { kind: 'open-queued', target: '/tasks?status=open' },
    };
    assert.equal(isValidDesktopDeepLinkAcknowledgement(connect), true);
    assert.equal(isValidDesktopDeepLinkAcknowledgement(open), true);
    assert.equal(isValidDesktopDeepLinkAcknowledgement({
      ...connect,
      consumption: { kind: 'connect-confirmation', target: 'https://attacker.example' },
    }), false);
    assert.equal(isValidDesktopDeepLinkAcknowledgement({
      ...open,
      consumption: { kind: 'open-navigated', target: '/plans' },
    }), false);
    assert.equal(isValidDesktopDeepLinkAcknowledgement({ ...connect, extra: true }), false);
  });

  it('logs out through the active Electron session with credentials and without following redirects', async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const desktopSession: Pick<Session, 'fetch'> = {
      fetch: async (input, init) => {
        requests.push({ url: input.toString(), init });
        return new Response(null, { status: 302 });
      },
    };

    await logoutDesktopSession(desktopSession, 'https://propr.example.com');

    assert.deepEqual(requests, [{
      url: 'https://propr.example.com/api/auth/logout',
      init: { credentials: 'include', redirect: 'manual' },
    }]);
  });

  it('rejects untrusted logout endpoints before making a session request', async () => {
    let requested = false;
    const desktopSession: Pick<Session, 'fetch'> = {
      fetch: async () => {
        requested = true;
        return new Response(null, { status: 200 });
      },
    };

    await assert.rejects(logoutDesktopSession(desktopSession, 'https://propr.example.com/base'), /Invalid desktop API URL/);
    await assert.rejects(logoutDesktopSession(desktopSession, 'https://user:secret@example.com'), /Invalid desktop API URL/);
    assert.equal(requested, false);
  });

  it('clears browser identity and origin storage for normalized profile origins when profiles switch', async () => {
    const calls: Array<Parameters<Session['clearStorageData']>[0]> = [];
    const desktopSession: Pick<Session, 'clearStorageData'> = {
      clearStorageData: async options => { calls.push(options ?? {}); },
    };

    await clearDesktopInstanceCookies(desktopSession, [
      'https://first.example.test',
      'https://second.example.test',
      'https://first.example.test',
    ]);

    assert.deepEqual(calls, [
      { origin: 'https://first.example.test', storages: ['cookies', 'localstorage', 'indexdb', 'cachestorage', 'serviceworkers'] },
      { origin: 'https://second.example.test', storages: ['cookies', 'localstorage', 'indexdb', 'cachestorage', 'serviceworkers'] },
    ]);
    await assert.rejects(
      clearDesktopInstanceCookies(desktopSession, ['http://remote.example.test']),
      /Invalid desktop API URL/,
    );
  });
});
