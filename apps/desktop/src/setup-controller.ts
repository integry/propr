import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  getLocalSetupCapability,
  retrySetup,
  runSetup,
  type GithubAuthDecision,
  type SetupActions,
  type SetupRunResult,
} from '@propr/local-setup';
import { DEFAULT_PROPR_GH_RELAY_URL } from '@propr/shared';
import type {
  DesktopProfileView,
  DesktopSetupRequest,
  DesktopSetupSnapshot,
} from './shared/contract';

interface PersistedSetupState {
  version: 1;
  snapshot: DesktopSetupSnapshot;
  resume: Pick<DesktopSetupRequest, 'rootDir' | 'agents'>;
}

export interface DesktopSetupControllerOptions {
  actions: SetupActions;
  platform?: NodeJS.Platform;
  statePath: string;
  defaultRootDir: string;
  resolveApiBaseUrl(rootDir: string): Promise<string>;
  registerProfile(profile: { name: string; apiBaseUrl: string }): Promise<DesktopProfileView>;
  emit(snapshot: DesktopSetupSnapshot): void;
}

const terminalPhase = (result: SetupRunResult): DesktopSetupSnapshot['phase'] => {
  if (result.completed) return 'completed';
  if (result.cancelled) return 'cancelled';
  return 'failed';
};

const safeMessage = (error: unknown): string =>
  error instanceof Error && error.message ? error.message : 'Local setup failed unexpectedly.';

const assertRequest = (value: DesktopSetupRequest): DesktopSetupRequest => {
  if (!value || typeof value !== 'object') throw new Error('Invalid local setup request');
  if (typeof value.rootDir !== 'string' || !value.rootDir.trim()) throw new Error('Choose a data directory');
  if (!Array.isArray(value.agents) || !value.agents.every(agent => typeof agent === 'string')) {
    throw new Error('Invalid agent selection');
  }
  if (!value.github || !['keep', 'demo', 'relay', 'app'].includes(value.github.mode)) {
    throw new Error('Invalid GitHub configuration');
  }
  if (!value.intake || !['keep', 'routing_websocket', 'polling', 'direct_webhook'].includes(value.intake.mode)) {
    throw new Error('Invalid GitHub intake configuration');
  }
  return value;
};

/**
 * Owns one setup run in Electron's trusted process. The renderer receives only
 * redacted engine state and bounded log lines; prompt values are never echoed
 * into the snapshot or persisted resume record.
 */
export class DesktopSetupController {
  readonly #options: DesktopSetupControllerOptions;
  #abortController: AbortController | null = null;
  #currentRun: Promise<DesktopSetupSnapshot> | null = null;
  #loaded = false;
  #persistQueue = Promise.resolve();
  #resume: PersistedSetupState['resume'] | null = null;
  #result: SetupRunResult | null = null;
  #snapshot: DesktopSetupSnapshot;

  constructor(options: DesktopSetupControllerOptions) {
    this.#options = options;
    const capability = getLocalSetupCapability(options.platform);
    this.#snapshot = {
      phase: capability.supported ? 'idle' : 'unsupported',
      capability,
      logs: [],
      rootDir: options.defaultRootDir,
      ...(capability.supported ? {} : { error: capability.reason }),
    };
  }

  async status(): Promise<DesktopSetupSnapshot> {
    await this.#load();
    return structuredClone(this.#snapshot);
  }

  start(request: DesktopSetupRequest): Promise<DesktopSetupSnapshot> {
    return this.#begin(assertRequest(request), false);
  }

  async retry(request?: DesktopSetupRequest): Promise<DesktopSetupSnapshot> {
    await this.#load();
    if (request) return this.#begin(assertRequest(request), true);
    if (!this.#resume) throw new Error('There is no local setup to resume');
    return this.#begin({
      rootDir: this.#resume.rootDir,
      reinitialize: false,
      agents: this.#resume.agents,
      loginAgents: [],
      github: { mode: 'keep' },
      intake: { mode: 'keep' },
      whitelist: null,
      repository: null,
    }, true);
  }

  cancel(): DesktopSetupSnapshot {
    this.#abortController?.abort();
    return structuredClone(this.#snapshot);
  }

  async shutdown(): Promise<void> {
    this.#abortController?.abort();
    await this.#currentRun?.catch(() => undefined);
    await this.#persistQueue;
  }

  async #begin(request: DesktopSetupRequest, retry: boolean): Promise<DesktopSetupSnapshot> {
    await this.#load();
    if (!this.#snapshot.capability.supported) throw new Error(this.#snapshot.capability.reason);
    if (this.#currentRun) throw new Error('Local setup is already running');

    this.#resume = { rootDir: request.rootDir, agents: [...request.agents] };
    this.#abortController = new AbortController();
    this.#snapshot = {
      phase: 'running',
      capability: this.#snapshot.capability,
      rootDir: request.rootDir,
      state: this.#snapshot.state,
      logs: retry ? [...this.#snapshot.logs, 'Retrying setup with a fresh host inspection…'].slice(-200) : [],
    };
    this.#publish();

    const operation = this.#run(request, retry);
    this.#currentRun = operation;
    try {
      return await operation;
    } finally {
      this.#currentRun = null;
      this.#abortController = null;
    }
  }

  async #run(request: DesktopSetupRequest, retry: boolean): Promise<DesktopSetupSnapshot> {
    const reporter = {
      onState: (state: SetupRunResult['state']) => {
        this.#snapshot = { ...this.#snapshot, rootDir: state.rootDir, state };
        this.#publish();
      },
      onLog: (line: string) => {
        this.#snapshot = { ...this.#snapshot, logs: [...this.#snapshot.logs, line].slice(-200) };
        this.#publish();
      },
    };
    const prompts = this.#prompts(request);

    try {
      const result = retry && this.#result
        ? await retrySetup(this.#result, {
            actions: this.#options.actions,
            prompts,
            reporter,
            platform: this.#options.platform,
            signal: this.#abortController?.signal,
          })
        : await runSetup({
            root: request.rootDir,
            actions: this.#options.actions,
            prompts,
            reporter,
            platform: this.#options.platform,
            signal: this.#abortController?.signal,
          });
      this.#result = result;

      let profile: DesktopProfileView | undefined;
      if (result.completed) {
        const apiBaseUrl = await this.#options.resolveApiBaseUrl(result.rootDir);
        profile = await this.#options.registerProfile({ name: 'This computer', apiBaseUrl });
      }
      this.#snapshot = {
        ...this.#snapshot,
        phase: terminalPhase(result),
        rootDir: result.rootDir,
        state: result.state,
        errors: result.errors,
        profile,
      };
    } catch (error) {
      this.#snapshot = {
        ...this.#snapshot,
        phase: this.#abortController?.signal.aborted ? 'cancelled' : 'failed',
        error: safeMessage(error),
      };
    }
    this.#publish();
    await this.#persistQueue;
    return structuredClone(this.#snapshot);
  }

  #prompts(request: DesktopSetupRequest) {
    return {
      resolveStackRoot: async () => ({ rootDir: request.rootDir, reinitialize: request.reinitialize }),
      selectAgents: async () => [...request.agents],
      configureGithubAuth: async (): Promise<GithubAuthDecision> => {
        switch (request.github.mode) {
          case 'keep': return { keep: true };
          case 'demo': return { mode: 'demo', vars: { PROPR_DEMO_MODE: 'true' } };
          case 'relay': return {
            mode: 'relay',
            enrollRelay: { relayUrl: request.github.relayUrl || DEFAULT_PROPR_GH_RELAY_URL },
          };
          case 'app': return {
            mode: 'app',
            vars: {
              PROPR_DEMO_MODE: 'false',
              GH_AUTH_MODE: 'app',
              GH_APP_ID: request.github.appId,
              HOST_GH_PRIVATE_KEY: request.github.privateKeyPath,
              GH_INSTALLATION_ID: request.github.installationId,
            },
          };
        }
      },
      // The desktop host's login action reuses an existing `gh` session without
      // ever launching a terminal-bound process behind the renderer.
      confirmGithubLogin: async () => true,
      confirmGithubAppInstall: async () => true,
      confirmGithubAppInstalled: async () => false,
      configureIntake: async () => {
        if (request.intake.mode === 'keep') return { keep: true };
        if (request.intake.mode === 'direct_webhook') {
          return { mode: request.intake.mode, webhookSecret: request.intake.webhookSecret };
        }
        return { mode: request.intake.mode };
      },
      confirmStartStack: async () => true,
      // Image logins are terminal applications. The desktop verifies the image
      // mount and surfaces the engine's exact recovery command instead of
      // launching an invisible TTY-bound process.
      confirmAgentLogin: async () => [],
      configureWhitelist: async () => request.whitelist,
      addRepository: async () => request.repository,
      launchUi: async () => false,
    };
  }

  async #load(): Promise<void> {
    if (this.#loaded) return;
    this.#loaded = true;
    try {
      const parsed = JSON.parse(await readFile(this.#options.statePath, 'utf8')) as PersistedSetupState;
      if (parsed.version !== 1 || !parsed.snapshot || !parsed.resume) return;
      this.#resume = parsed.resume;
      this.#snapshot = {
        ...parsed.snapshot,
        phase: parsed.snapshot.phase === 'running' ? 'interrupted' : parsed.snapshot.phase,
        error: parsed.snapshot.phase === 'running'
          ? 'Setup was interrupted when ProPR Desktop closed. Retry safely to resume.'
          : parsed.snapshot.error,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.#snapshot = { ...this.#snapshot, error: 'Previous setup progress could not be loaded.' };
      }
    }
  }

  #publish(): void {
    const copy = structuredClone(this.#snapshot);
    this.#options.emit(copy);
    if (!this.#resume) return;
    const persisted: PersistedSetupState = { version: 1, snapshot: copy, resume: this.#resume };
    this.#persistQueue = this.#persistQueue.then(async () => {
      await mkdir(dirname(this.#options.statePath), { recursive: true, mode: 0o700 });
      const temporary = `${this.#options.statePath}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify(persisted, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, this.#options.statePath);
    }).catch(() => undefined);
  }
}
