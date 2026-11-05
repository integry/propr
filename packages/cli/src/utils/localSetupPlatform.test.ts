import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { localSetupSearchPath } from './localSetupPlatform.js';

test('Finder path finds Docker Desktop and optional GitHub CLI without reading a shell profile', () => {
  const result = localSetupSearchPath('darwin', '/usr/bin:/bin', '/Users/Test User')!.split(':');
  assert.ok(result.includes('/Applications/Docker.app/Contents/Resources/bin'));
  assert.ok(result.includes('/Users/Test User/.docker/bin'));
  assert.ok(result.includes('/opt/homebrew/bin'));
  assert.equal(result[0], '/usr/bin');
  assert.equal(localSetupSearchPath('darwin', result.join(':'), '/Users/Test User'), result.join(':'));
  assert.equal(localSetupSearchPath('linux', '/custom/bin'), '/custom/bin');
  assert.equal(localSetupSearchPath('win32', 'C:\\Windows'), 'C:\\Windows');
  assert.ok(!localSetupSearchPath('darwin', ':.:relative:/bin', '/Users/Test')!.split(':').includes('.'));
});


test('Docker child environment scopes Finder discovery without mutating the host', async () => {
  // Shared launcher is deliberately dependency-free JavaScript.
  // @ts-ignore module is loaded directly from source in this regression
  const { dockerExecutionEnvironment } = await import('../../../../docker/launcher/orchestrator.mjs');
  const parent = Object.freeze({ PATH: '/custom/bin:/usr/bin', HOME: '/Users/Test', DOCKER_HOST: 'unix:///selected' });
  const result = dockerExecutionEnvironment(parent, 'darwin');
  assert.notEqual(result, parent);
  assert.equal(result.PATH, localSetupSearchPath('darwin', parent.PATH, parent.HOME));
  assert.equal(result.DOCKER_HOST, parent.DOCKER_HOST);
  assert.equal(parent.PATH, '/custom/bin:/usr/bin');
  assert.equal(dockerExecutionEnvironment(parent, 'linux'), parent);
  const withoutHome = Object.freeze({ PATH: '/usr/bin', DOCKER_HOST: 'unix:///selected' });
  const fallback = dockerExecutionEnvironment(withoutHome, 'darwin');
  assert.ok(fallback.PATH.split(':').includes(join(homedir(), '.docker', 'bin')));
  assert.equal(fallback.DOCKER_HOST, withoutHome.DOCKER_HOST);
  assert.equal(fallback.HOME, undefined);
  assert.equal(withoutHome.PATH, '/usr/bin');
});
