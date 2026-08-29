import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rename, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { writePrivateFileAtomic, type SetupActions } from '@propr/local-setup';
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
    detectGithubAuthMode() { return { mode: env.PROPR_DEMO_MODE === 'true' ? 'demo' : env.GH_AUTH_MODE === 'relay' ? 'relay' : env.GH_AUTH_MODE === 'app' ? 'app' : 'none', warnings: [] }; },
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
      selectPrivateKey: async () => null,
      resolveApiBaseUrl: async () => 'http://127.0.0.1:4000',
      registerProfile: async ({ name, apiBaseUrl }) => ({ id: 'local', name, baseUrl: apiBaseUrl, kind: 'local' }),
      emit: snapshot => snapshots.push(snapshot.phase),
    });

    const { sessionId } = await controller.status();
    const result = await controller.start({
      sessionId,
      root: { mode: 'default' },
      reinitialize: false,
      agents: [],
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
      selectPrivateKey: async () => null,
      resolveApiBaseUrl: async () => { throw new Error('not called'); },
      registerProfile: async () => { throw new Error('not called'); },
      emit() {},
    });

    const status = await controller.status();
    assert.equal(status.phase, 'unsupported');
    assert.equal(status.capability.kind, 'remote-only');
    await assert.rejects(async () => controller.start({} as never), /Invalid local setup request|not supported/);
  });

  it('awaits aborted host work before publishing cancelled and permits retry only after settlement', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'propr-desktop-cancel-'));
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    let stopped = false;
    let registered = false;
    const actions = fakeActions();
    actions.runChecks = ({ root, signal }) => new Promise(resolve => {
      entered();
      signal?.addEventListener('abort', () => {
        stopped = true;
        resolve({ rootDir: root!, anyFail: false, results: [] });
      }, { once: true });
    });
    const controller = new DesktopSetupController({
      actions, platform: 'linux', statePath: join(directory, 'state.json'), defaultRootDir: join(directory, 'stack'),
      selectPrivateKey: async () => null,
      resolveApiBaseUrl: async () => 'http://127.0.0.1:4000',
      registerProfile: async () => { registered = true; throw new Error('must not run'); }, emit() {},
    });
    const { sessionId } = await controller.status();
    const running = controller.start({ sessionId, root: { mode: 'default' }, reinitialize: false, agents: [], github: { mode: 'demo' }, intake: { mode: 'keep' }, whitelist: null, repository: null });
    await started;
    await assert.rejects(controller.retry(), /already running/);
    const cancelled = await controller.cancel();
    assert.equal(stopped, true);
    assert.equal(cancelled.phase, 'cancelled');
    assert.equal((await running).phase, 'cancelled');
    assert.equal(registered, false);
  });

  it('pins relay enrollment to the official relay and rejects attacker-controlled URL fields', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'propr-desktop-relay-'));
    const seen: unknown[] = [];
    const actions = fakeActions();
    actions.hasGithubToken = () => true;
    actions.fetchRelayInstallations = async params => {
      seen.push(params);
      return { username: 'octocat', installations: [{ installation_id: 42, account_login: 'integry', account_type: 'Organization' }] };
    };
    actions.enrollRelay = async params => {
      seen.push(params);
      return { relayUrl: params.relayUrl!, token: 'ghr_super-secret-relay-token' };
    };
    const controller = new DesktopSetupController({
      actions, platform: 'linux', statePath: join(directory, 'state.json'), defaultRootDir: join(directory, 'stack'),
      selectPrivateKey: async () => null,
      resolveApiBaseUrl: async () => 'http://127.0.0.1:4000', registerProfile: async () => ({ id: 'local', name: 'Local', baseUrl: 'http://127.0.0.1:4000', kind: 'local' }), emit() {},
    });
    const { sessionId } = await controller.status();
    const request = { sessionId, root: { mode: 'default' as const }, reinitialize: false, agents: [], github: { mode: 'relay' as const }, intake: { mode: 'polling' as const }, whitelist: ['octocat'], repository: null };
    await controller.start(request);
    assert.ok(seen.length >= 2);
    assert.equal(seen.every(value => JSON.stringify(value).includes('https://webhook.propr.dev/v1')), true);
    assert.doesNotMatch(JSON.stringify(seen), /attacker|authorization/i);
    await assert.rejects(async () => controller.start({ ...request, github: { mode: 'relay', relayUrl: 'https://attacker.invalid' } } as never), /Invalid/);
  });

  it('aborts and settles blocked host work during shutdown', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'propr-desktop-shutdown-'));
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    let stopped = false;
    const actions = fakeActions();
    actions.runChecks = ({ root, signal }) => new Promise(resolve => {
      entered();
      signal?.addEventListener('abort', () => { stopped = true; resolve({ rootDir: root!, anyFail: false, results: [] }); }, { once: true });
    });
    const controller = new DesktopSetupController({
      actions, platform: 'linux', statePath: join(directory, 'state.json'), defaultRootDir: join(directory, 'stack'),
      selectPrivateKey: async () => null,
      resolveApiBaseUrl: async () => 'http://127.0.0.1:4000', registerProfile: async () => { throw new Error('not called'); }, emit() {},
    });
    const status = await controller.status();
    const run = controller.start({ sessionId: status.sessionId, root: { mode: 'default' }, reinitialize: false, agents: [], github: { mode: 'demo' }, intake: { mode: 'keep' }, whitelist: null, repository: null });
    await started;
    await controller.shutdown();
    assert.equal(stopped, true);
    assert.equal((await run).phase, 'cancelled');
  });

  it('threads cancellation into deferred profile registration and suppresses the late write', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'propr-desktop-profile-cancel-'));
    let entered!: () => void;
    const registering = new Promise<void>(resolve => { entered = resolve; });
    let registered = false;
    const controller = new DesktopSetupController({
      actions: fakeActions(), platform: 'linux', statePath: join(directory, 'state.json'), defaultRootDir: join(directory, 'stack'),
      selectPrivateKey: async () => null,
      resolveApiBaseUrl: async () => 'http://127.0.0.1:4000',
      registerProfile: async (_profile, signal) => {
        entered();
        await new Promise<void>((resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true }));
        registered = true;
        return { id: 'late', name: 'Late', baseUrl: 'http://127.0.0.1:4000', kind: 'local' };
      }, emit() {},
    });
    const status = await controller.status();
    const run = controller.start({ sessionId: status.sessionId, root: { mode: 'default' }, reinitialize: false, agents: [], github: { mode: 'demo' }, intake: { mode: 'keep' }, whitelist: null, repository: null });
    await registering;
    const result = await controller.cancel();
    assert.equal(result.phase, 'cancelled');
    assert.equal((await run).phase, 'cancelled');
    assert.equal(registered, false);
  });

  it('persists every non-secret choice and requires secret reconfiguration after restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'propr-desktop-resume-'));
    const keyPath = join(directory, 'github-app.pem');
    const keyContents = '-----BEGIN PRIVATE KEY-----\nultra-secret-key-content\n-----END PRIVATE KEY-----';
    await writeFile(keyPath, keyContents, { mode: 0o600 });
    await chmod(keyPath, 0o600);
    const statePath = join(directory, 'state.json');
    const options = {
      actions: fakeActions(), platform: 'linux' as const, statePath, defaultRootDir: join(directory, 'stack'),
      selectPrivateKey: async () => keyPath,
      promptWebhookSecret: async () => 'arbitrary-webhook-value',
      resolveApiBaseUrl: async () => 'http://127.0.0.1:4000', registerProfile: async () => ({ id: 'local', name: 'Local', baseUrl: 'http://127.0.0.1:4000', kind: 'local' as const }), emit() {},
    };
    const first = new DesktopSetupController(options);
    const status = await first.status();
    const key = await first.selectPrivateKey();
    const secret = await first.acquireWebhookSecret();
    assert.ok(key);
    assert.ok(secret);
    await first.start({
      sessionId: status.sessionId, root: { mode: 'default' }, reinitialize: true, agents: ['claude'],
      github: { mode: 'app', appId: '123', installationId: '456', privateKeyCapability: key.capability },
      intake: { mode: 'direct_webhook', secretCapability: secret.capability }, whitelist: [], repository: { fullName: 'integry/propr', alias: 'propr', baseBranch: 'main' },
    });
    const persisted = await readFile(statePath, 'utf8');
    assert.doesNotMatch(persisted, /arbitrary-webhook-value|ultra-secret-key-content|github-app\.pem/);
    assert.match(persisted, /"agents": \[\s*"claude"/);
    assert.match(persisted, /"fullName": "integry\/propr"/);

    const restarted = new DesktopSetupController({ ...options, sessionId: '11111111-1111-4111-8111-111111111111' });
    const resumed = await restarted.status();
    assert.equal(resumed.reconfigurationRequired, true);
    assert.equal(resumed.resume?.reconfigurationStage, 'github');
    assert.deepEqual(resumed.resume?.whitelist, []);
    assert.deepEqual(resumed.resume?.repository, { fullName: 'integry/propr', alias: 'propr', baseBranch: 'main' });
    await assert.rejects(restarted.retry(), /Re-enter the github/);
  });

  it('recomputes platform support after shared concurrent hydration instead of trusting Linux state', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'propr-desktop-hydration-'));
    const statePath = join(directory, 'state.json');
    const linux = new DesktopSetupController({
      actions: fakeActions(), platform: 'linux', statePath, defaultRootDir: join(directory, 'stack'), selectPrivateKey: async () => null,
      resolveApiBaseUrl: async () => 'http://127.0.0.1:4000', registerProfile: async () => ({ id: 'local', name: 'Local', baseUrl: 'http://127.0.0.1:4000', kind: 'local' }), emit() {},
    });
    const current = await linux.status();
    await linux.start({ sessionId: current.sessionId, root: { mode: 'default' }, reinitialize: false, agents: [], github: { mode: 'demo' }, intake: { mode: 'keep' }, whitelist: null, repository: null });

    const concurrentSession = '33333333-3333-4333-8333-333333333333';
    const rehydrated = new DesktopSetupController({
      actions: fakeActions(), platform: 'linux', statePath, defaultRootDir: join(directory, 'stack'), sessionId: concurrentSession, selectPrivateKey: async () => null,
      resolveApiBaseUrl: async () => 'http://127.0.0.1:4000', registerProfile: async () => ({ id: 'local', name: 'Local', baseUrl: 'http://127.0.0.1:4000', kind: 'local' }), emit() {},
    });
    const [hydratedStatus, hydratedStart] = await Promise.all([
      rehydrated.status(),
      rehydrated.start({ sessionId: concurrentSession, root: { mode: 'resume' }, reinitialize: false, agents: [], github: { mode: 'demo' }, intake: { mode: 'keep' }, whitelist: null, repository: null }),
    ]);
    assert.equal(hydratedStatus.capability.supported, true);
    assert.equal(hydratedStart.phase, 'completed');

    const sessionId = '22222222-2222-4222-8222-222222222222';
    const darwin = new DesktopSetupController({
      actions: {} as SetupActions, platform: 'darwin', statePath, defaultRootDir: join(directory, 'stack'), sessionId, selectPrivateKey: async () => null,
      resolveApiBaseUrl: async () => { throw new Error('not called'); }, registerProfile: async () => { throw new Error('not called'); }, emit() {},
    });
    const [one, two] = await Promise.all([darwin.status(), darwin.status()]);
    assert.equal(one.phase, 'unsupported');
    assert.deepEqual(one.capability, two.capability);
    await assert.rejects(darwin.start({ sessionId, root: { mode: 'resume' }, reinitialize: false, agents: [], github: { mode: 'demo' }, intake: { mode: 'keep' }, whitelist: null, repository: null }), /not supported/);
  });

  it('surfaces persistence failure as resume unavailable', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'propr-desktop-persist-fail-'));
    const blocker = join(directory, 'not-a-directory');
    await writeFile(blocker, 'block');
    const controller = new DesktopSetupController({
      actions: fakeActions(), platform: 'linux', statePath: join(blocker, 'state.json'), defaultRootDir: join(directory, 'stack'),
      selectPrivateKey: async () => null,
      resolveApiBaseUrl: async () => 'http://127.0.0.1:4000', registerProfile: async () => ({ id: 'local', name: 'Local', baseUrl: 'http://127.0.0.1:4000', kind: 'local' }), emit() {},
    });
    const status = await controller.status();
    const result = await controller.start({ sessionId: status.sessionId, root: { mode: 'default' }, reinitialize: false, agents: [], github: { mode: 'demo' }, intake: { mode: 'keep' }, whitelist: null, repository: null });
    assert.equal(result.resumeAvailable, false);
    assert.match(result.error ?? '', /Resume after restart is unavailable/);
  });

  it('rejects managed paths that escape the fixed app-owned root', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'propr-desktop-contained-root-'));
    const root = join(directory, 'default');
    const outside = join(directory, 'outside');
    await mkdir(root); await mkdir(outside); await symlink(outside, join(root, 'data'));
    const controller = new DesktopSetupController({
      actions: fakeActions(), platform: 'linux', statePath: join(directory, 'state.json'), defaultRootDir: join(directory, 'default'),
      selectPrivateKey: async () => null,
      resolveApiBaseUrl: async () => 'http://127.0.0.1:4000', registerProfile: async () => { throw new Error('not called'); }, emit() {},
    });
    const status = await controller.status();
    const result = await controller.start({ sessionId: status.sessionId, root: { mode: 'default' }, reinitialize: false, agents: [], github: { mode: 'demo' }, intake: { mode: 'keep' }, whitelist: null, repository: null });
    assert.equal(result.phase, 'failed');
    assert.doesNotMatch(result.error ?? '', new RegExp(outside));
  });

  it('uses a generic renderer error while retaining only sanitized protected diagnostics', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'propr-desktop-generic-error-'));
    const actions = fakeActions();
    const diagnostics: unknown[] = [];
    const controller = new DesktopSetupController({
      actions, platform: 'linux', statePath: join(directory, 'state.json'), defaultRootDir: join(directory, 'stack'),
      selectPrivateKey: async () => null,
      resolveApiBaseUrl: async () => 'http://127.0.0.1:4000', registerProfile: async () => { throw new Error('profile failure included ghp_1234567890abcdef and Authorization: Bearer relay-auth-value'); }, emit() {},
      diagnose: (_event, fields) => diagnostics.push(fields),
    });
    const status = await controller.status();
    const result = await controller.start({ sessionId: status.sessionId, root: { mode: 'default' }, reinitialize: false, agents: [], github: { mode: 'demo' }, intake: { mode: 'keep' }, whitelist: null, repository: null });
    assert.match(result.error ?? '', /failed unexpectedly/);
    const serialized = JSON.stringify(diagnostics);
    assert.doesNotMatch(serialized, /ghp_1234567890abcdef|relay-auth-value/);
    assert.match(serialized, /REDACTED/);
  });

  it('quit and reopen resumes against the fixed root without any directory reselection', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'propr-desktop-fixed-resume-'));
    const root = join(directory, 'default');
    const statePath = join(directory, 'state.json');
    const first = new DesktopSetupController({
      actions: fakeActions(), platform: 'linux', statePath, defaultRootDir: join(directory, 'default'),
      selectPrivateKey: async () => null,
      resolveApiBaseUrl: async () => 'http://127.0.0.1:4000', registerProfile: async () => ({ id: 'local', name: 'Local', baseUrl: 'http://127.0.0.1:4000', kind: 'local' }), emit() {},
    });
    const status = await first.status();
    await first.start({ sessionId: status.sessionId, root: { mode: 'default' }, reinitialize: false, agents: [], github: { mode: 'demo' }, intake: { mode: 'keep' }, whitelist: null, repository: null });
    await first.shutdown();

    let actions = 0;
    const replacementActions = fakeActions();
    replacementActions.runChecks = async ({ root: checked }) => { actions += 1; return { rootDir: checked!, anyFail: false, results: [] }; };
    const restarted = new DesktopSetupController({
      actions: replacementActions, platform: 'linux', statePath, defaultRootDir: join(directory, 'default'),
      selectPrivateKey: async () => null,
      resolveApiBaseUrl: async () => 'http://127.0.0.1:4000', registerProfile: async () => ({ id: 'local', name: 'Local', baseUrl: 'http://127.0.0.1:4000', kind: 'local' }), emit() {},
    });
    const resumed = await restarted.status();
    assert.equal(resumed.rootDir, root);
    assert.equal(resumed.resume?.reconfigurationStage, undefined);
    assert.equal((await restarted.retry()).phase, 'completed');
    assert.ok(actions > 0);
  });

  it('never reads or mounts a formerly chosen replacement directory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'propr-desktop-no-custom-root-'));
    const fixedRoot = join(directory, 'fixed');
    const chosenRoot = join(directory, 'chosen');
    const sentinel = 'CHOSEN_REPLACEMENT_SENTINEL_UNCHANGED';
    await mkdir(chosenRoot, { mode: 0o700 });
    await writeFile(join(chosenRoot, '.env'), sentinel, { mode: 0o600 });
    const observedRoots: string[] = [];
    const actions = fakeActions();
    actions.runChecks = async ({ root }) => { observedRoots.push(root!); return { rootDir: root!, anyFail: false, results: [] }; };
    actions.startStack = async ({ rootDir, assertRootAuthority }) => { observedRoots.push(rootDir); assertRootAuthority?.(); };
    const controller = new DesktopSetupController({
      actions, platform: 'linux', statePath: join(directory, 'state.json'), defaultRootDir: fixedRoot,
      selectPrivateKey: async () => null,
      resolveApiBaseUrl: async () => 'http://127.0.0.1:4000', registerProfile: async () => ({ id: 'local', name: 'Local', baseUrl: 'http://127.0.0.1:4000', kind: 'local' }), emit() {},
    });
    const status = await controller.status();
    const result = await controller.start({ sessionId: status.sessionId, root: { mode: 'default' }, reinitialize: false, agents: [], github: { mode: 'demo' }, intake: { mode: 'keep' }, whitelist: null, repository: null });
    assert.equal(result.phase, 'completed');
    assert.equal(await readFile(join(chosenRoot, '.env'), 'utf8'), sentinel);
    assert.equal(observedRoots.some(value => value.startsWith(chosenRoot)), false);
    assert.ok(observedRoots.includes(fixedRoot));
  });

  it('copies a consumed private key once and never reopens a swapped chooser pathname', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'propr-desktop-key-copy-'));
    const keyPath = join(directory, 'app.pem');
    const original = 'ORIGINAL_PRIVATE_KEY_BYTES';
    const replacement = 'REPLACEMENT_MUST_NOT_BE_READ';
    await writeFile(keyPath, original, { mode: 0o600 });
    let release!: () => void;
    let entered!: () => void;
    const atChecks = new Promise<void>(resolve => { entered = resolve; });
    const continueChecks = new Promise<void>(resolve => { release = resolve; });
    let mountedPath: string | undefined;
    const actions = fakeActions();
    actions.runChecks = async ({ root }) => {
      entered(); await continueChecks;
      return { rootDir: root!, anyFail: false, results: [{ name: 'Docker daemon', group: 'Docker', status: 'ok', detail: 'ready' }] };
    };
    const baseApply = actions.applyEnvSelection;
    actions.applyEnvSelection = (root, values, options, signal) => {
      if (values.HOST_GH_PRIVATE_KEY) mountedPath = values.HOST_GH_PRIVATE_KEY;
      return baseApply(root, values, options, signal);
    };
    const controller = new DesktopSetupController({
      actions, platform: 'linux', statePath: join(directory, 'state.json'), defaultRootDir: join(directory, 'stack'), keyStorageDir: join(directory, 'owned-keys'),
      selectPrivateKey: async () => keyPath,
      resolveApiBaseUrl: async () => 'http://127.0.0.1:4000', registerProfile: async () => { throw new Error('not called'); }, emit() {},
    });
    const status = await controller.status();
    const selected = await controller.selectPrivateKey();
    assert.ok(selected);
    const running = controller.start({
      sessionId: status.sessionId, root: { mode: 'default' }, reinitialize: false, agents: [],
      github: { mode: 'app', appId: '1', installationId: '2', privateKeyCapability: selected.capability },
      intake: { mode: 'polling' }, whitelist: null, repository: null,
    });
    await atChecks;
    await rename(keyPath, `${keyPath}.original`);
    await writeFile(keyPath, replacement, { mode: 0o600 });
    release();
    await running;
    assert.ok(mountedPath);
    assert.notEqual(mountedPath, keyPath);
    assert.equal(await readFile(mountedPath, 'utf8'), original);
    assert.doesNotMatch(await readFile(mountedPath, 'utf8'), /REPLACEMENT/);
  });

  it('keeps an atomic env commit descriptor-relative when the fixed root is renamed and replaced', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'propr-desktop-root-commit-'));
    const selectedRoot = join(directory, 'fixed');
    const originalRoot = join(directory, 'fixed-original');
    const sentinel = 'REPLACEMENT_SENTINEL_MUST_SURVIVE';
    await mkdir(selectedRoot, { mode: 0o700 });
    const emitted: unknown[] = [];
    let swapped = false;
    let operationRoot = '';
    const actions = fakeActions();
    actions.applyEnvSelection = (rootDir, values, _options, signal) => {
      operationRoot = rootDir;
      writePrivateFileAtomic(join(rootDir, '.env'), Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n'), {
        signal,
        beforeRename() {
          if (swapped) return;
          swapped = true;
          renameSync(selectedRoot, originalRoot);
          mkdirSync(selectedRoot, { mode: 0o700 });
          writeFileSync(join(selectedRoot, '.env'), sentinel, { mode: 0o600 });
        },
      });
      return { written: Object.keys(values), skipped: [] };
    };
    const controller = new DesktopSetupController({
      actions, platform: 'linux', statePath: join(directory, 'state.json'), defaultRootDir: selectedRoot,
      selectPrivateKey: async () => null,
      resolveApiBaseUrl: async () => 'http://127.0.0.1:4000', registerProfile: async () => { throw new Error('not called'); }, emit: snapshot => emitted.push(snapshot),
    });
    const status = await controller.status();
    const result = await controller.start({
      sessionId: status.sessionId, root: { mode: 'default' }, reinitialize: false, agents: [],
      github: { mode: 'demo' }, intake: { mode: 'keep' }, whitelist: null, repository: null,
    });
    assert.equal(result.phase, 'failed');
    assert.match(operationRoot, new RegExp(`^/proc/${process.pid}/fd/[0-9]+$`));
    assert.equal(readFileSync(join(selectedRoot, '.env'), 'utf8'), sentinel);
    assert.match(readFileSync(join(originalRoot, '.env'), 'utf8'), /PROPR_DEMO_MODE=true/);
    assert.doesNotMatch(JSON.stringify({ result, emitted }), new RegExp(`/proc/${process.pid}/fd/`));
    assert.equal((await controller.retry()).phase, 'failed', 'retry starts only after the failed run settled');
    await controller.shutdown();
  });

  it('hands Docker only the stable fixed root and fails if that identity is replaced', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'propr-desktop-root-docker-'));
    const selectedRoot = join(directory, 'fixed');
    const originalRoot = join(directory, 'fixed-original');
    const sentinel = 'DO_NOT_READ_OR_BIND_REPLACEMENT';
    await mkdir(selectedRoot, { mode: 0o700 });
    let launched = false;
    let daemonRoot = '';
    let operationsRoot = '';
    const actions = fakeActions();
    actions.startStack = async params => {
      daemonRoot = params.rootDir;
      operationsRoot = params.rootOperationsDir ?? '';
      renameSync(selectedRoot, originalRoot);
      mkdirSync(selectedRoot, { mode: 0o700 });
      writeFileSync(join(selectedRoot, '.env'), sentinel, { mode: 0o600 });
      params.assertRootAuthority?.();
      launched = true;
    };
    const controller = new DesktopSetupController({
      actions, platform: 'linux', statePath: join(directory, 'state.json'), defaultRootDir: selectedRoot,
      selectPrivateKey: async () => null,
      resolveApiBaseUrl: async () => 'http://127.0.0.1:4000', registerProfile: async () => { throw new Error('not called'); }, emit() {},
    });
    const status = await controller.status();
    const result = await controller.start({
      sessionId: status.sessionId, root: { mode: 'default' }, reinitialize: false, agents: [],
      github: { mode: 'demo' }, intake: { mode: 'keep' }, whitelist: null, repository: null,
    });
    assert.equal(result.phase, 'failed');
    assert.equal(launched, false);
    assert.equal(daemonRoot, selectedRoot);
    assert.doesNotMatch(daemonRoot, /(?:^|\/)proc\/|(?:^|\/)dev\/fd/);
    assert.match(operationsRoot, new RegExp(`^/proc/${process.pid}/fd/[0-9]+$`));
    assert.equal(readFileSync(join(selectedRoot, '.env'), 'utf8'), sentinel);
    assert.equal((await controller.retry()).phase, 'failed', 'retry starts only after the failed run settled');
    await controller.shutdown();
  });

  it('keeps native webhook secret bytes out of snapshots, resume state, logs, errors, and diagnostics', async () => {
    const sentinel = 'SENTINEL_NATIVE_SECRET_9f08c7';
    const directory = await mkdtemp(join(tmpdir(), 'propr-desktop-secret-boundary-'));
    const emitted: unknown[] = [];
    const diagnostics: unknown[] = [];
    const actions = fakeActions();
    actions.hasGithubToken = () => true;
    actions.inspectDatastoreAdministrators = async () => ({ status: 'has-admin' });
    actions.pullImages = async ({ onLog }) => {
      onLog?.(`progress ${sentinel}`);
      return { pulledCore: ['api'], pulledAgents: [], failedCore: [], failedAgents: [] };
    };
    actions.startStack = async () => { throw new Error(`daemon failure ${sentinel}`); };
    const statePath = join(directory, 'state.json');
    const controller = new DesktopSetupController({
      actions, platform: 'linux', statePath, defaultRootDir: join(directory, 'stack'),
      selectPrivateKey: async () => null, promptWebhookSecret: async () => sentinel,
      resolveApiBaseUrl: async () => 'http://127.0.0.1:4000', registerProfile: async () => { throw new Error('not called'); }, emit: snapshot => emitted.push(snapshot),
      diagnose: (_event, fields) => diagnostics.push(fields),
    });
    const status = await controller.status();
    const secret = await controller.acquireWebhookSecret();
    assert.ok(secret);
    assert.doesNotMatch(JSON.stringify(secret), new RegExp(sentinel));
    const result = await controller.start({
      sessionId: status.sessionId, root: { mode: 'default' }, reinitialize: false, agents: [],
      github: { mode: 'keep' },
      intake: { mode: 'direct_webhook', secretCapability: secret.capability }, whitelist: null, repository: null,
    });
    const rendererVisible = JSON.stringify({ result, emitted, diagnostics, persisted: await readFile(statePath, 'utf8') });
    assert.doesNotMatch(rendererVisible, new RegExp(sentinel));
    assert.match(rendererVisible, /REDACTED/);
    await assert.rejects(controller.retry(), /Re-enter the intake/);
  });
});
