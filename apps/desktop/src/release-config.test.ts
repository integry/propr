import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { describe, test } from 'node:test';
import {
  readCompleteEnvironmentGroup,
  resolveDesktopVersion,
  resolveTrustedUpdateBuildConfig,
} from './release-config';

const publicKey = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).toString('base64');

describe('desktop release configuration', () => {
  test('propagates an explicit independent desktop version', () => {
    assert.equal(resolveDesktopVersion('0.8.15', { PROPR_DESKTOP_VERSION: '2.3.4' }), '2.3.4');
    assert.throws(() => resolveDesktopVersion('0.8.15', { PROPR_DESKTOP_VERSION: 'v2.3.4' }), /stable semver/);
    assert.throws(() => resolveDesktopVersion('0.8.15', { PROPR_DESKTOP_VERSION: '2.3.4-beta.1' }), /stable semver/);
  });

  test('keeps updates disabled unless they are explicitly enabled', () => {
    assert.deepEqual(resolveTrustedUpdateBuildConfig({}), {
      enabled: false,
      manifestUrl: '',
      publicKey: '',
      signingIdentity: '',
    });
  });

  test('requires a signed build and a complete trusted update configuration', () => {
    const base = {
      PROPR_DESKTOP_ENABLE_UPDATES: '1',
      PROPR_DESKTOP_UPDATE_MANIFEST_URL: 'https://updates.example.test/stable/desktop-release.json',
      PROPR_DESKTOP_UPDATE_PUBLIC_KEY: publicKey,
      PROPR_DESKTOP_UPDATE_SIGNING_IDENTITY: 'Example Publisher',
    };
    assert.throws(() => resolveTrustedUpdateBuildConfig(base), /CODE_SIGNED/);
    assert.deepEqual(resolveTrustedUpdateBuildConfig({ ...base, PROPR_DESKTOP_CODE_SIGNED: '1' }), {
      enabled: true,
      manifestUrl: 'https://updates.example.test/stable/desktop-release.json',
      publicKey,
      signingIdentity: 'Example Publisher',
    });
    assert.throws(
      () => resolveTrustedUpdateBuildConfig({ ...base, PROPR_DESKTOP_CODE_SIGNED: '1', PROPR_DESKTOP_UPDATE_MANIFEST_URL: 'http://example.test/update.json' }),
      /HTTPS/,
    );
  });

  test('rejects partially configured signing groups', () => {
    assert.equal(readCompleteEnvironmentGroup({}, ['CERT', 'PASSWORD'], 'Windows signing'), undefined);
    assert.throws(
      () => readCompleteEnvironmentGroup({ CERT: '/tmp/cert.pfx' }, ['CERT', 'PASSWORD'], 'Windows signing'),
      /missing PASSWORD/,
    );
  });
});

