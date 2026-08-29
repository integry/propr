import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Session } from 'electron';
import { clearDesktopInstanceCookies, logoutDesktopSession } from './desktop-session';

describe('desktop session IPC operations', () => {
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

  it('clears only cookies for normalized profile origins when profiles switch', async () => {
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
      { origin: 'https://first.example.test', storages: ['cookies'] },
      { origin: 'https://second.example.test', storages: ['cookies'] },
    ]);
    await assert.rejects(
      clearDesktopInstanceCookies(desktopSession, ['http://remote.example.test']),
      /Invalid desktop API URL/,
    );
  });
});
