import assert from 'node:assert/strict';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { describe, it } from 'node:test';
import { createDesktopLogger } from './logger';
import { configureNativeSmokeLogsPath } from './smoke-log-path';

const waitForFile = async (path: string): Promise<void> => {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      readFileSync(path);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  throw new Error('Timed out waiting for the smoke log file');
};

describe('native smoke Electron logs path', () => {
  it('leaves ordinary production and Windows paths unchanged', () => {
    const calls: Array<[string, string]> = [];
    const app = { setPath: (name: 'logs', path: string) => calls.push([name, path]) };
    assert.equal(configureNativeSmokeLogsPath({
      app,
      authorizedNativeSmoke: false,
      platform: 'darwin',
      userDataDirectory: '/private/unused',
    }), null);
    assert.equal(configureNativeSmokeLogsPath({
      app,
      authorizedNativeSmoke: true,
      platform: 'win32',
      userDataDirectory: 'C:\\unused',
    }), null);
    assert.deepEqual(calls, []);
  });

  it('keeps authorized Mac/Linux smoke logs at 0700/0600 inside the isolated profile', async () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const profile = mkdtempSync(join(tmpdir(), 'propr-desktop-smoke-log-'));
      const logs = join(profile, 'logs');
      const calls: Array<[string, string]> = [];
      try {
        mkdirSync(logs, { mode: 0o700 });
        chmodSync(logs, 0o700);
        const configured = configureNativeSmokeLogsPath({
          app: { setPath: (name, path) => calls.push([name, path]) },
          authorizedNativeSmoke: true,
          platform,
          userDataDirectory: profile,
        });
        assert.equal(configured, logs);
        assert.deepEqual(calls, [['logs', logs]]);
        assert.ok(configured);

        const log = join(configured, 'desktop.jsonl');
        createDesktopLogger(log).log('info', 'desktop.test');
        await waitForFile(log);
        const logsFromProfile = relative(profile, configured);
        assert.ok(logsFromProfile && !logsFromProfile.startsWith('..') && !isAbsolute(logsFromProfile));
        assert.equal(lstatSync(configured).mode & 0o777, 0o700);
        assert.equal(lstatSync(log).mode & 0o777, 0o600);
      } finally {
        rmSync(profile, { recursive: true, force: true });
      }
    }
  });
});
