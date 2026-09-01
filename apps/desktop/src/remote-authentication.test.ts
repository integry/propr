import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { openRemoteAuthentication, remoteAuthenticationUrl } from './remote-authentication';

describe('desktop remote authentication sink', () => {
  it('opens only the canonical browser sign-in endpoint with a validated recovery link', async () => {
    const opened: string[] = [];
    await openRemoteAuthentication({ profileId: 'remote-1', apiBaseUrl: 'https://team.example.com' }, async url => {
      opened.push(url);
    });

    assert.equal(opened.length, 1);
    const endpoint = new URL(opened[0]);
    assert.equal(endpoint.origin, 'https://team.example.com');
    assert.equal(endpoint.pathname, '/api/auth/github');
    assert.deepEqual([...endpoint.searchParams.keys()], ['redirect_to']);
    const recovery = new URL(endpoint.searchParams.get('redirect_to')!);
    assert.equal(recovery.href, 'propr://connect?api=https%3A%2F%2Fteam.example.com');
  });

  it('rejects non-canonical, local, credentialed, and attacker-controlled endpoints before the sink', () => {
    for (const apiBaseUrl of [
      'https://team.example.com/',
      'https://team.example.com/path',
      'https://user:secret@team.example.com',
      'http://127.0.0.1:4000',
      'http://attacker.example.com',
    ]) {
      assert.throws(() => remoteAuthenticationUrl({ profileId: 'remote-1', apiBaseUrl }));
    }
    assert.throws(() => remoteAuthenticationUrl({ profileId: '../remote', apiBaseUrl: 'https://team.example.com' }));
  });
});
