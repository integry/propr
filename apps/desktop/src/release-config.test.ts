import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { describe, test } from 'node:test';
import {
  readCompleteEnvironmentGroup,
  requireProductionReleaseConfiguration,
  resolveDesktopVersion,
  resolveTrustedUpdateBuildConfig,
} from './release-config';
import { squirrelAppUserModelId } from './squirrel-events';

const publicKey = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).toString('base64');

interface LinuxMaker {
  name: 'deb' | 'rpm';
  config: { options?: { bin?: string } };
  prepareConfig: (targetArch: 'x64') => Promise<void>;
}

const isLinuxMaker = (maker: unknown): maker is LinuxMaker => {
  if (typeof maker !== 'object' || maker === null || !('name' in maker)) return false;
  return maker.name === 'deb' || maker.name === 'rpm';
};

describe('desktop release configuration', () => {
  test('keeps Linux maker executables aligned with the packaged executable', async () => {
    const previousDeb = process.env.PROPR_DESKTOP_ENABLE_DEB;
    const previousRpm = process.env.PROPR_DESKTOP_ENABLE_RPM;
    process.env.PROPR_DESKTOP_ENABLE_DEB = '1';
    process.env.PROPR_DESKTOP_ENABLE_RPM = '1';
    try {
      const { default: forgeConfig } = await import('../forge.config');
      const executableName = forgeConfig.packagerConfig?.executableName;
      assert.equal(executableName, 'propr-desktop');
      assert.equal(squirrelAppUserModelId(executableName), 'com.squirrel.propr_desktop.propr-desktop');

      const linuxMakers = forgeConfig.makers?.filter(isLinuxMaker) ?? [];
      assert.deepEqual(linuxMakers.map(maker => maker.name).sort(), ['deb', 'rpm']);
      for (const maker of linuxMakers) {
        await maker.prepareConfig('x64');
        assert.equal(maker.config.options?.bin, executableName);
        assert.notEqual(maker.config.options?.bin, '@propr/desktop');
      }
    } finally {
      if (previousDeb === undefined) delete process.env.PROPR_DESKTOP_ENABLE_DEB;
      else process.env.PROPR_DESKTOP_ENABLE_DEB = previousDeb;
      if (previousRpm === undefined) delete process.env.PROPR_DESKTOP_ENABLE_RPM;
      else process.env.PROPR_DESKTOP_ENABLE_RPM = previousRpm;
    }
  });

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
    assert.throws(
      () => resolveTrustedUpdateBuildConfig({ ...base, PROPR_DESKTOP_CODE_SIGNED: '1', PROPR_DESKTOP_UPDATE_MANIFEST_URL: 'https://example.test/update.json?channel=stable' }),
      /query/,
    );
  });

  test('rejects partially configured signing groups', () => {
    assert.equal(readCompleteEnvironmentGroup({}, ['CERT', 'PASSWORD'], 'Windows signing'), undefined);
    assert.throws(
      () => readCompleteEnvironmentGroup({ CERT: '/tmp/cert.pfx' }, ['CERT', 'PASSWORD'], 'Windows signing'),
      /missing PASSWORD/,
    );
  });

  test('fails closed when a production signing or notarization condition is absent', () => {
    const enabledUpdates = resolveTrustedUpdateBuildConfig({
      PROPR_DESKTOP_ENABLE_UPDATES: '1',
      PROPR_DESKTOP_CODE_SIGNED: '1',
      PROPR_DESKTOP_UPDATE_MANIFEST_URL: 'https://updates.example.test/stable/desktop-release.json',
      PROPR_DESKTOP_UPDATE_PUBLIC_KEY: publicKey,
      PROPR_DESKTOP_UPDATE_SIGNING_IDENTITY: 'TEAM123456',
    });
    const group = { configured: 'yes' };
    assert.throws(
      () => requireProductionReleaseConfiguration({ platform: 'darwin', updateConfig: enabledUpdates, macSigning: group }),
      /notarization/,
    );
    assert.throws(
      () => requireProductionReleaseConfiguration({ platform: 'darwin', updateConfig: { enabled: false, manifestUrl: '', publicKey: '', signingIdentity: '' }, macSigning: group, macNotarization: group }),
      /signed updates/,
    );
    assert.throws(
      () => requireProductionReleaseConfiguration({ platform: 'win32', updateConfig: enabledUpdates }),
      /Authenticode/,
    );
    assert.doesNotThrow(
      () => requireProductionReleaseConfiguration({ platform: 'darwin', updateConfig: enabledUpdates, macSigning: group, macNotarization: group }),
    );
    assert.doesNotThrow(
      () => requireProductionReleaseConfiguration({ platform: 'win32', updateConfig: enabledUpdates, windowsSigning: group }),
    );
  });
});
