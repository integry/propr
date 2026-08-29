import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { authenticatedDesktopRequestHeaders } from './desktop-request-auth';
import { ProfileStore } from './profile-store';

describe('desktop authenticated request boundary', () => {
  it('injects the encrypted active credential only for the exact profile origin', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'propr-desktop-request-'));
    const profiles = new ProfileStore(directory, {
      isEncryptionAvailable: () => true,
      backend: () => 'secret-service',
      encrypt: value => Buffer.from(`encrypted:${value}`),
      decrypt: value => value.toString().replace(/^encrypted:/, ''),
    });
    const profile = await profiles.save({ label: 'Team', apiBaseUrl: 'https://propr.example.test' });
    await profiles.setActive(profile.id);
    await profiles.writeCredential(profile.id, 'propr_it_secret');
    const options = {
      profiles,
      packagedRendererUrl: 'propr-app://renderer/renderer.html',
      rendererWebContentsId: 7,
    };

    const authenticated = await authenticatedDesktopRequestHeaders({
      url: 'https://propr.example.test/api/status',
      initiator: 'propr-app://renderer',
      webContentsId: 7,
      requestHeaders: { Accept: 'application/json' },
    }, options);
    assert.equal(authenticated.Authorization, 'Bearer propr_it_secret');

    const crossOrigin = await authenticatedDesktopRequestHeaders({
      url: 'https://attacker.example/api/status',
      initiator: 'propr-app://renderer',
      webContentsId: 7,
      requestHeaders: {},
    }, options);
    assert.equal(crossOrigin.Authorization, undefined);

    const untrustedRenderer = await authenticatedDesktopRequestHeaders({
      url: 'https://propr.example.test/api/status',
      initiator: 'https://attacker.example',
      webContentsId: 99,
      requestHeaders: {},
    }, options);
    assert.equal(untrustedRenderer.Authorization, undefined);
  });
});
