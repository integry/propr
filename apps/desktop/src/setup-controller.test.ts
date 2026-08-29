import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { SetupActions } from '@propr/local-setup';
import { DesktopSetupController } from './setup-controller';

const fakeActions = (): SetupActions => {
  const env: Record<string, string> = {};
  return {
    async runChecks({ root }) {
      return { rootDir: root!, anyFail: false, results: [{ name: 'Docker daemon', group: 'Docker', status: 'ok', detail: 'ready' }] };
    },
    inspectStackInit(rootDir) {
      return { rootDir, envExists: false, dirs: { data: false, logs: false, repos: false }, initialized: false };
    },
    async inspectDatastoreAdministrators() { return { status: 'absent' }; },
    async scaffoldStack({ root }) {
      return { rootDir: root!, envCreated: true, envSkipped: false, envBackedUp: false, dirsCreated: ['data', 'logs', 'repos'], dirsSkipped: [] };
    },
    async persistStackRoot() {},
    readEnvVars() { return { ...env }; },
    applyEnvSelection(_root, values, options) {
      const written: string[] = [];
      const skipped: string[] = [];
      for (const [key, value] of Object.entries(values)) {
        if (!options?.overwrite && env[key]) skipped.push(key);
        else { env[key] = value; written.push(key); }
      }
      return { written, skipped };
    },
    clearEnvKeys(_root, keys) { keys.forEach(key => delete env[key]); },
    detectGithubAuthMode() { return { mode: env.PROPR_DEMO_MODE === 'true' ? 'demo' : 'none', warnings: [] }; },
    prepareAgentCredentialDir() {},
    async pullImages({ onLog }) {
      onLog?.('token=must-not-cross-ipc');
      return { pulledCore: ['api'], pulledAgents: [], failedCore: [], failedAgents: [] };
    },
    async isStackRunning() { return false; },
    async startStack() {},
    async checkBackendHealth() { return { healthy: true, detail: 'API healthy' }; },
    async addRepository() {},
    async resolveUiUrl() { return 'http://127.0.0.1:5173'; },
    async openUrl() {},
    async saveWhitelistSetting() {},
    hasGithubToken() { return false; },
    async fetchRelayInstallations() { return { username: 'owner', installations: [] }; },
    async enrollRelay() { return { relayUrl: 'https://connect.propr.dev', token: 'secret' }; },
    async loginWithGithub() { return false; },
    async listAgents() { return []; },
    async addAgent() {},
    async loginableAgents() { return []; },
    async loginAgent() { return { available: false, success: false }; },
    async validateAgents() { return []; },
  };
};

describe('desktop local setup controller', () => {
  it('runs the injected host adapter, redacts progress, persists resume state, and registers the healthy profile', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'propr-desktop-setup-'));
    const statePath = join(directory, 'setup.json');
    const snapshots: string[] = [];
    const controller = new DesktopSetupController({
      actions: fakeActions(),
      platform: 'linux',
      statePath,
      defaultRootDir: join(directory, 'stack'),
      resolveApiBaseUrl: async () => 'http://127.0.0.1:4000',
      registerProfile: async ({ name, apiBaseUrl }) => ({ id: 'local', name, baseUrl: apiBaseUrl, kind: 'local' }),
      emit: snapshot => snapshots.push(snapshot.phase),
    });

    const result = await controller.start({
      rootDir: join(directory, 'stack'),
      reinitialize: false,
      agents: [],
      loginAgents: [],
      github: { mode: 'demo' },
      intake: { mode: 'keep' },
      whitelist: null,
      repository: null,
    });

    assert.equal(result.phase, 'completed');
    assert.equal(result.profile?.baseUrl, 'http://127.0.0.1:4000');
    assert.match(result.logs.join('\n'), /\[REDACTED\]/);
    assert.doesNotMatch(result.logs.join('\n'), /must-not-cross-ipc/);
    assert.ok(snapshots.includes('running'));
    const persisted = await readFile(statePath, 'utf8');
    assert.doesNotMatch(persisted, /must-not-cross-ipc/);
    assert.doesNotMatch(persisted, /PROPR_DEMO_MODE/);
  });

  it('reports remote-only capability on non-Linux hosts without invoking setup actions', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'propr-desktop-unsupported-'));
    const controller = new DesktopSetupController({
      actions: {} as SetupActions,
      platform: 'darwin',
      statePath: join(directory, 'setup.json'),
      defaultRootDir: join(directory, 'stack'),
      resolveApiBaseUrl: async () => { throw new Error('not called'); },
      registerProfile: async () => { throw new Error('not called'); },
      emit() {},
    });

    const status = await controller.status();
    assert.equal(status.phase, 'unsupported');
    assert.equal(status.capability.kind, 'remote-only');
    assert.throws(() => controller.start({} as never), /Invalid local setup request|Choose a data directory|not supported/);
  });
});
