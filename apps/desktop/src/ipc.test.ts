import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Session } from 'electron';
import { logoutDesktopSession } from './desktop-session';

describe('desktop session IPC operations', () => {
  it('logs out through the active Electron session with credentials and without following redirects', async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const desktopSession: Pick<Session, 'fetch'> = {
      fetch: async (input, init) => {
        requests.push({ url: input.toString(), init });
        return new Response(null, { status: 302 });
      },
    };

    await logoutDesktopSession(desktopSession, 'https://propr.example.com/base');

    assert.deepEqual(requests, [{
      url: 'https://propr.example.com/base/api/auth/logout',
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

    await assert.rejects(logoutDesktopSession(desktopSession, 'https://user:secret@example.com'), /Invalid desktop API URL/);
    assert.equal(requested, false);
  });
});
