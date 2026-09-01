import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { ConfigManager } from './config/ConfigManager.js';
import { discoverConfiguredConnect } from './desktopDiscovery.js';
import type { ConnectStatusDocument } from './commands/connectCommand.js';

const directories: string[] = [];

after(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('fixed desktop Connect discovery entry point', () => {
  test('Linux configured discovery executes the target-native directory authority addon', {
    skip: process.platform !== 'linux' || (process.arch !== 'x64' && process.arch !== 'arm64')
      ? 'requires a packaged Linux native addon target'
      : false,
  }, async () => {
    const parent = await mkdtemp(join(tmpdir(), 'propr-desktop-discovery-linux-'));
    directories.push(parent);
    const configRoot = join(parent, '.propr');
    const nativeRoot = join(parent, 'stack');
    const config = new ConfigManager(configRoot, { warn: () => undefined });
    await config.init();
    await config.setStackRoot(nativeRoot);
    let receivedRoot: string | undefined;
    const status: ConnectStatusDocument = {
      schemaVersion: 1,
      status: 'notReady',
      canonicalEndpoint: null,
      publicInstanceIdentity: null,
      configured: false,
      enabled: false,
      sidecarRunning: false,
      apiReady: false,
      restartRequired: false,
      compatibility: null,
      version: null,
      reasonCodes: ['NOT_CONFIGURED'],
    };

    assert.equal(await discoverConfiguredConnect({
      configRoot,
      platform: 'linux',
      readStatus: async root => {
        receivedRoot = root;
        return status;
      },
    }), status);
    assert.equal(receivedRoot, nativeRoot);
  });

  test('ordinary Windows discovery reads only the saved native root from fixed config', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'propr-desktop-discovery-'));
    directories.push(parent);
    const configRoot = join(parent, '.propr');
    const nativeRoot = String.raw`C:\Users\standard\propr-stack`;
    const config = new ConfigManager(configRoot, { warn: () => undefined });
    await config.init();
    await config.setStackRoot(nativeRoot);
    let receivedRoot: string | undefined;
    const status: ConnectStatusDocument = {
      schemaVersion: 1,
      status: 'notReady',
      canonicalEndpoint: null,
      publicInstanceIdentity: null,
      configured: false,
      enabled: false,
      sidecarRunning: false,
      apiReady: false,
      restartRequired: false,
      compatibility: null,
      version: null,
      reasonCodes: ['NOT_CONFIGURED'],
    };

    assert.equal(await discoverConfiguredConnect({
      configRoot,
      platform: 'win32',
      readStatus: async root => {
        receivedRoot = root;
        return status;
      },
    }), status);
    assert.equal(receivedRoot, nativeRoot);
  });
});
