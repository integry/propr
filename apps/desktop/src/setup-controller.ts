import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { chmod, lstat, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  getLocalSetupCapability,
  retrySetup,
  runSetup,
  type GithubAuthDecision,
  type SetupActions,
  type SetupRunResult,
} from '@propr/local-setup';
import { DEFAULT_PROPR_GH_RELAY_URL } from '@propr/shared';
import { redactDesktopValue, safeRendererError } from './secret-redaction';
import { SetupFilesystemCapabilities, validatePrivateKeyPath } from './setup-capabilities';
import { parseDesktopSetupRequest, SetupRequestError } from './setup-schema';
import type {
  DesktopFilesystemSelection,
  DesktopProfileView,
  DesktopSetupRequest,
  DesktopSetupResumeView,
  DesktopSetupSnapshot,
} from './shared/contract';

interface ResumePlan extends DesktopSetupResumeView {
  root: { mode: 'default' | 'selected'; path: string };
}

interface PersistedSetupState {
  version: 2;
  phase: Exclude<DesktopSetupSnapshot['phase'], 'unsupported'>;
  rootDir: string;
  lastStepId?: string;
  resume: ResumePlan;
}

interface ResolvedRequest {
  publicRequest: DesktopSetupRequest;
  rootDir: string;
  rootMode: 'default' | 'selected';
  privateKeyPath?: string;
  rootIdentity?: { device: bigint; inode: bigint };
}

export interface DesktopSetupControllerOptions {
  actions: SetupActions;
  platform?: NodeJS.Platform;
  statePath: string;
  defaultRootDir: string;
  selectDirectory(): Promise<string | null>;
  selectPrivateKey(): Promise<string | null>;
  resolveApiBaseUrl(rootDir: string, signal?: AbortSignal): Promise<string>;
  registerProfile(profile: { name: string; apiBaseUrl: string }, signal?: AbortSignal): Promise<DesktopProfileView>;
  emit(snapshot: DesktopSetupSnapshot): void;
  diagnose?(event: string, fields: Record<string, unknown>): void;
  sessionId?: string;
}

const PHASES = new Set(['idle', 'running', 'interrupted', 'cancelled', 'failed', 'completed']);
const STEPS = new Set(['check', 'init-stack', 'pull-images', 'configure-agents', 'github-auth', 'intake', 'start-stack', 'enable-agents', 'whitelist', 'repo', 'launch-ui']);

const terminalPhase = (result: SetupRunResult): DesktopSetupSnapshot['phase'] => result.completed ? 'completed' : result.cancelled ? 'cancelled' : 'failed';

const assertPath = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 4_096 && isAbsolute(value) && !value.includes('\0');

const parseResumePlan = (value: unknown): ResumePlan => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid resume plan');
  const plan = value as Record<string, unknown>;
  if (Object.keys(plan).some(key => !['root', 'reinitialize', 'agents', 'loginAgents', 'github', 'intake', 'whitelist', 'repository', 'reconfigurationStage'].includes(key))) throw new Error('Invalid resume plan');
  const root = plan.root as Record<string, unknown> | undefined;
  if (!root || Object.keys(root).some(key => !['mode', 'path'].includes(key)) || Object.keys(root).length !== 2 || !['default', 'selected'].includes(String(root.mode)) || !assertPath(root.path)) throw new Error('Invalid resume root');
  const github = plan.github as Record<string, unknown> | undefined;
  const intake = plan.intake as Record<string, unknown> | undefined;
  if (!github || !intake) throw new Error('Invalid resume plan');
  const githubKeys = github.mode === 'app' ? ['mode', 'appId', 'installationId', 'reconfigurationRequired'] : ['mode'];
  const intakeKeys = intake.mode === 'direct_webhook' ? ['mode', 'reconfigurationRequired'] : ['mode'];
  if (Object.keys(github).length !== githubKeys.length || Object.keys(github).some(key => !githubKeys.includes(key))
    || Object.keys(intake).length !== intakeKeys.length || Object.keys(intake).some(key => !intakeKeys.includes(key))) throw new Error('Invalid resume plan');
  const synthetic = parseDesktopSetupRequest({
    sessionId: randomUUID(),
    root: { mode: 'default' },
    reinitialize: plan.reinitialize,
    agents: plan.agents,
    loginAgents: plan.loginAgents,
    github: github?.mode === 'app'
      ? { mode: 'app', appId: github.appId, installationId: github.installationId, privateKeyCapability: 'A'.repeat(43) }
      : github,
    intake: intake?.mode === 'direct_webhook' ? { mode: 'direct_webhook', webhookSecret: 'reconfigure' } : intake,
    whitelist: plan.whitelist,
    repository: plan.repository,
  });
  if (github?.mode === 'app' && github.reconfigurationRequired !== true) throw new Error('Invalid resume plan');
  if (intake?.mode === 'direct_webhook' && intake.reconfigurationRequired !== true) throw new Error('Invalid resume plan');
  const expectedStage = github?.mode === 'app' ? 'github' : intake?.mode === 'direct_webhook' ? 'intake' : undefined;
  if (plan.reconfigurationStage !== expectedStage) throw new Error('Invalid resume plan');
  return {
    root: { mode: root.mode as 'default' | 'selected', path: resolve(root.path as string) },
    reinitialize: synthetic.reinitialize,
    agents: synthetic.agents,
    loginAgents: synthetic.loginAgents,
    github: github as unknown as ResumePlan['github'],
    intake: intake as unknown as ResumePlan['intake'],
    whitelist: synthetic.whitelist,
    repository: synthetic.repository,
    ...(expectedStage ? { reconfigurationStage: expectedStage } : {}),
  };
};

const parsePersisted = (contents: string): PersistedSetupState => {
  if (contents.length > 1024 * 1024) throw new Error('Setup state is too large');
  const value = JSON.parse(contents) as Record<string, unknown>;
  if (!value || value.version !== 2 || !PHASES.has(String(value.phase)) || !assertPath(value.rootDir)) throw new Error('Invalid setup state');
  if (value.lastStepId !== undefined && (typeof value.lastStepId !== 'string' || !STEPS.has(value.lastStepId))) throw new Error('Invalid setup state');
  if (Object.keys(value).some(key => !['version', 'phase', 'rootDir', 'lastStepId', 'resume'].includes(key))) throw new Error('Invalid setup state');
  return {
    version: 2,
    phase: value.phase as PersistedSetupState['phase'],
    rootDir: resolve(value.rootDir as string),
    ...(value.lastStepId ? { lastStepId: value.lastStepId as string } : {}),
    resume: parseResumePlan(value.resume),
  };
};

const resumeView = (plan: ResumePlan): DesktopSetupResumeView => ({
  reinitialize: plan.reinitialize,
  agents: [...plan.agents],
  loginAgents: [...plan.loginAgents],
  github: structuredClone(plan.github),
  intake: structuredClone(plan.intake),
  whitelist: plan.whitelist ? [...plan.whitelist] : null,
  repository: plan.repository ? { ...plan.repository } : null,
  ...(plan.reconfigurationStage ? { reconfigurationStage: plan.reconfigurationStage } : {}),
});

export class DesktopSetupController {
  readonly #options: DesktopSetupControllerOptions;
  readonly #sessionId: string;
  readonly #filesystem = new SetupFilesystemCapabilities();
  #abortController: AbortController | null = null;
  #activeSecrets: string[] = [];
  #busy = false;
  #currentRun: Promise<DesktopSetupSnapshot> | null = null;
  #hydration: Promise<void> | null = null;
  #persistQueue = Promise.resolve();
  #persistFailed = false;
  #resume: ResumePlan | null = null;
  #runtimeRetry: ResolvedRequest | null = null;
  #result: SetupRunResult | null = null;
  #snapshot: DesktopSetupSnapshot;

  constructor(options: DesktopSetupControllerOptions) {
    this.#options = options;
    this.#sessionId = options.sessionId ?? randomUUID();
    const capability = this.#capability();
    this.#snapshot = {
      phase: capability.supported ? 'idle' : 'unsupported',
      capability,
      sessionId: this.#sessionId,
      logs: [],
      rootDir: resolve(options.defaultRootDir),
      resumeAvailable: false,
      ...(capability.supported ? {} : { error: capability.reason }),
    };
  }

  async status(): Promise<DesktopSetupSnapshot> {
    await this.#load();
    this.#enforceCapability(false);
    return this.#copy();
  }

  async selectDirectory(): Promise<DesktopFilesystemSelection | null> {
    await this.#load();
    this.#enforceCapability(true);
    try {
      const selected = await this.#options.selectDirectory();
      return selected ? await this.#filesystem.issue('directory', this.#sessionId, selected) : null;
    } catch (error) {
      if (error instanceof SetupRequestError) throw error;
      this.#diagnose('desktop.setup.directory_selection_failed', { error });
      throw new Error(safeRendererError);
    }
  }

  async selectPrivateKey(): Promise<DesktopFilesystemSelection | null> {
    await this.#load();
    this.#enforceCapability(true);
    try {
      const selected = await this.#options.selectPrivateKey();
      return selected ? await this.#filesystem.issue('private-key', this.#sessionId, selected) : null;
    } catch (error) {
      this.#diagnose('desktop.setup.private_key_selection_failed', { error });
      throw new Error(safeRendererError);
    }
  }

  start(input: unknown): Promise<DesktopSetupSnapshot> {
    return this.#begin(parseDesktopSetupRequest(input), false);
  }

  async retry(input?: unknown): Promise<DesktopSetupSnapshot> {
    await this.#load();
    this.#enforceCapability(true);
    if (input !== undefined) return this.#begin(parseDesktopSetupRequest(input), true);
    if (this.#runtimeRetry) return this.#beginResolved(this.#runtimeRetry, true);
    if (!this.#resume) throw new SetupRequestError('There is no local setup to resume');
    if (this.#resume.reconfigurationStage) throw new SetupRequestError(`Re-enter the ${this.#resume.reconfigurationStage} configuration before retrying.`);
    const request = parseDesktopSetupRequest({
      sessionId: this.#sessionId,
      root: { mode: 'resume' },
      reinitialize: this.#resume.reinitialize,
      agents: this.#resume.agents,
      loginAgents: this.#resume.loginAgents,
      github: this.#resume.github,
      intake: this.#resume.intake,
      whitelist: this.#resume.whitelist,
      repository: this.#resume.repository,
    });
    return this.#begin(request, true);
  }

  async cancel(): Promise<DesktopSetupSnapshot> {
    this.#abortController?.abort();
    if (this.#currentRun) await this.#currentRun.catch(() => undefined);
    return this.#copy();
  }

  async shutdown(): Promise<void> {
    this.#abortController?.abort();
    await this.#currentRun?.catch(() => undefined);
    await this.#persistQueue;
    this.#filesystem.clear();
  }

  async #begin(request: DesktopSetupRequest, retry: boolean): Promise<DesktopSetupSnapshot> {
    await this.#load();
    this.#enforceCapability(true);
    if (this.#busy || this.#currentRun) throw new SetupRequestError('Local setup is already running');
    this.#busy = true;
    try {
      if (request.sessionId !== this.#sessionId) throw new SetupRequestError('The setup session expired. Start again.');
      const consumed: string[] = [];
      let rootDir: string;
      let rootMode: 'default' | 'selected';
      if (request.root.mode === 'default') {
        rootDir = resolve(this.#options.defaultRootDir);
        rootMode = 'default';
      } else if (request.root.mode === 'resume') {
        if (!this.#resume) throw new SetupRequestError('The resumed setup directory is unavailable.');
        rootDir = await this.#validatedResumeRoot(this.#resume.root);
        rootMode = this.#resume.root.mode;
      } else {
        const selectedRoot = request.root as { mode: 'selected'; capability: string };
        rootDir = await this.#filesystem.validate(selectedRoot.capability, 'directory', this.#sessionId);
        rootMode = 'selected';
        consumed.push(selectedRoot.capability);
      }
      let privateKeyPath: string | undefined;
      if (request.github.mode === 'app') {
        privateKeyPath = await this.#filesystem.validate(request.github.privateKeyCapability, 'private-key', this.#sessionId);
        consumed.push(request.github.privateKeyCapability);
      }
      this.#filesystem.consume(consumed);
      const rootInfo = rootMode === 'selected' ? lstatSync(rootDir, { bigint: true }) : undefined;
      return await this.#beginResolved({ publicRequest: request, rootDir, rootMode, privateKeyPath, ...(rootInfo ? { rootIdentity: { device: rootInfo.dev, inode: rootInfo.ino } } : {}) }, retry);
    } finally {
      if (!this.#currentRun) this.#busy = false;
    }
  }

  async #beginResolved(resolved: ResolvedRequest, retry: boolean): Promise<DesktopSetupSnapshot> {
    this.#enforceCapability(true);
    if (this.#currentRun) throw new SetupRequestError('Local setup is already running');
    this.#busy = true;
    this.#resume = this.#resumePlan(resolved);
    this.#runtimeRetry = resolved;
    this.#activeSecrets = [resolved.privateKeyPath, resolved.publicRequest.intake.mode === 'direct_webhook' ? resolved.publicRequest.intake.webhookSecret : undefined].filter((value): value is string => Boolean(value));
    this.#abortController = new AbortController();
    this.#snapshot = {
      phase: 'running',
      capability: this.#capability(),
      sessionId: this.#sessionId,
      rootDir: resolved.rootDir,
      state: this.#snapshot.state,
      logs: retry ? [...this.#snapshot.logs, 'Retrying setup with a fresh host inspection…'].slice(-200) : [],
      resume: resumeView(this.#resume),
      resumeAvailable: false,
    };
    this.#publish();
    const operation = this.#run(resolved, retry);
    this.#currentRun = operation;
    try {
      return await operation;
    } finally {
      this.#currentRun = null;
      this.#abortController = null;
      this.#busy = false;
    }
  }

  async #run(resolved: ResolvedRequest, retry: boolean): Promise<DesktopSetupSnapshot> {
    const signal = this.#abortController!.signal;
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
    try {
      const result = retry && this.#result
        ? await retrySetup(this.#result, { actions: this.#boundActions(resolved), prompts: this.#prompts(resolved), reporter, platform: this.#platform(), signal })
        : await runSetup({ root: resolved.rootDir, actions: this.#boundActions(resolved), prompts: this.#prompts(resolved), reporter, platform: this.#platform(), signal });
      this.#result = result;
      signal.throwIfAborted();
      let profile: DesktopProfileView | undefined;
      if (result.completed) {
        const apiBaseUrl = await this.#options.resolveApiBaseUrl(result.rootDir, signal);
        signal.throwIfAborted();
        profile = await this.#options.registerProfile({ name: 'This computer', apiBaseUrl }, signal);
        signal.throwIfAborted();
      }
      this.#snapshot = { ...this.#snapshot, phase: terminalPhase(result), rootDir: result.rootDir, state: result.state, errors: result.errors, profile };
    } catch (error) {
      const cancelled = signal.aborted;
      if (!cancelled) this.#diagnose('desktop.setup.run_failed', { error });
      this.#snapshot = { ...this.#snapshot, phase: cancelled ? 'cancelled' : 'failed', error: cancelled ? 'Setup was cancelled.' : safeRendererError };
    }
    this.#publish();
    await this.#persistQueue;
    return this.#copy();
  }

  #prompts(resolved: ResolvedRequest) {
    const request = resolved.publicRequest;
    return {
      resolveStackRoot: async () => ({ rootDir: resolved.rootDir, reinitialize: request.reinitialize }),
      selectAgents: async () => [...request.agents],
      configureGithubAuth: async (): Promise<GithubAuthDecision> => {
        switch (request.github.mode) {
          case 'keep': return { keep: true };
          case 'demo': return { mode: 'demo', vars: { PROPR_DEMO_MODE: 'true' } };
          case 'relay': return { mode: 'relay', enrollRelay: { relayUrl: DEFAULT_PROPR_GH_RELAY_URL } };
          case 'app':
            if (!resolved.privateKeyPath) throw new SetupRequestError('Select the GitHub App private key again.');
            await validatePrivateKeyPath(resolved.privateKeyPath);
            return { mode: 'app', vars: { PROPR_DEMO_MODE: 'false', GH_AUTH_MODE: 'app', GH_APP_ID: request.github.appId, HOST_GH_PRIVATE_KEY: resolved.privateKeyPath, GH_INSTALLATION_ID: request.github.installationId } };
        }
      },
      confirmGithubLogin: async () => true,
      confirmGithubAppInstall: async () => true,
      confirmGithubAppInstalled: async () => false,
      configureIntake: async () => request.intake.mode === 'keep' ? { keep: true } : request.intake.mode === 'direct_webhook'
        ? { mode: request.intake.mode, webhookSecret: request.intake.webhookSecret }
        : { mode: request.intake.mode },
      confirmStartStack: async () => true,
      confirmAgentLogin: async () => [],
      configureWhitelist: async () => request.whitelist,
      addRepository: async () => request.repository,
      launchUi: async () => false,
    };
  }

  #boundActions(resolved: ResolvedRequest): SetupActions {
    if (!resolved.rootIdentity) return this.#options.actions;
    const guard = () => {
      const current = lstatSync(resolved.rootDir, { bigint: true });
      if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== resolved.rootIdentity!.device
        || current.ino !== resolved.rootIdentity!.inode || realpathSync(resolved.rootDir) !== resolved.rootDir) {
        throw new SetupRequestError('The selected setup directory changed. Select it again.');
      }
      for (const name of ['.env', 'data', 'logs', 'repos']) {
        const child = join(resolved.rootDir, name);
        if (!existsSync(child)) continue;
        const childInfo = lstatSync(child);
        const childRelative = relative(resolved.rootDir, realpathSync(child));
        if (childInfo.isSymbolicLink() || childRelative.startsWith('..') || isAbsolute(childRelative)) {
          throw new SetupRequestError('The selected setup directory contains an unsafe managed path.');
        }
      }
    };
    return new Proxy(this.#options.actions, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => { guard(); return Reflect.apply(value, target, args); };
      },
    });
  }

  #resumePlan(resolved: ResolvedRequest): ResumePlan {
    const request = resolved.publicRequest;
    const github: ResumePlan['github'] = request.github.mode === 'app'
      ? { mode: 'app', appId: request.github.appId, installationId: request.github.installationId, reconfigurationRequired: true }
      : structuredClone(request.github);
    const intake: ResumePlan['intake'] = request.intake.mode === 'direct_webhook'
      ? { mode: 'direct_webhook', reconfigurationRequired: true }
      : structuredClone(request.intake);
    return {
      root: { mode: resolved.rootMode, path: resolved.rootDir },
      reinitialize: request.reinitialize,
      agents: [...request.agents],
      loginAgents: [...request.loginAgents],
      github,
      intake,
      whitelist: request.whitelist ? [...request.whitelist] : null,
      repository: request.repository ? { ...request.repository } : null,
      ...(request.github.mode === 'app' ? { reconfigurationStage: 'github' as const } : request.intake.mode === 'direct_webhook' ? { reconfigurationStage: 'intake' as const } : {}),
    };
  }

  async #validatedResumeRoot(root: ResumePlan['root']): Promise<string> {
    if (root.mode === 'default') {
      const expected = resolve(this.#options.defaultRootDir);
      if (root.path !== expected) throw new SetupRequestError('The resumed setup directory is invalid.');
      return expected;
    }
    const info = await lstat(root.path);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(root.path) !== root.path) throw new SetupRequestError('Select the setup directory again.');
    return root.path;
  }

  #platform(): NodeJS.Platform {
    return this.#options.platform ?? process.platform;
  }

  #capability() {
    return getLocalSetupCapability(this.#platform());
  }

  #enforceCapability(throwWhenUnsupported: boolean): void {
    const capability = this.#capability();
    this.#snapshot = { ...this.#snapshot, capability, sessionId: this.#sessionId, phase: capability.supported ? this.#snapshot.phase === 'unsupported' ? 'idle' : this.#snapshot.phase : 'unsupported', ...(capability.supported ? {} : { error: capability.reason }) };
    if (!capability.supported && throwWhenUnsupported) throw new SetupRequestError(capability.reason);
  }

  async #load(): Promise<void> {
    this.#hydration ??= this.#hydrate();
    await this.#hydration;
  }

  async #hydrate(): Promise<void> {
    try {
      const parsed = parsePersisted(await readFile(this.#options.statePath, 'utf8'));
      this.#resume = parsed.resume;
      const interrupted = parsed.phase === 'running';
      this.#snapshot = {
        ...this.#snapshot,
        phase: interrupted ? 'interrupted' : parsed.phase,
        rootDir: parsed.rootDir,
        logs: [],
        resume: resumeView(parsed.resume),
        resumeAvailable: true,
        reconfigurationRequired: Boolean(parsed.resume.reconfigurationStage),
        ...(interrupted ? { error: 'Setup was interrupted when ProPR Desktop closed. Review the saved choices to continue.' } : {}),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.#diagnose('desktop.setup.hydration_failed', { error });
        this.#snapshot = { ...this.#snapshot, resumeAvailable: false, error: 'Previous setup progress could not be loaded. Resume is unavailable.' };
      }
    }
    this.#enforceCapability(false);
  }

  #publish(): void {
    this.#options.emit(this.#copy());
    if (!this.#resume || this.#persistFailed) return;
    const persisted: PersistedSetupState = {
      version: 2,
      phase: this.#snapshot.phase === 'unsupported' ? 'idle' : this.#snapshot.phase,
      rootDir: this.#resume.root.path,
      lastStepId: this.#snapshot.state?.steps.find(step => step.status === 'active')?.id,
      resume: this.#resume,
    };
    this.#persistQueue = this.#persistQueue.then(async () => {
      await mkdir(dirname(this.#options.statePath), { recursive: true, mode: 0o700 });
      const temporary = `${this.#options.statePath}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify(redactDesktopValue(persisted), null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, this.#options.statePath);
      await chmod(this.#options.statePath, 0o600);
      this.#snapshot = { ...this.#snapshot, resumeAvailable: true };
    }).catch(error => {
      this.#persistFailed = true;
      this.#diagnose('desktop.setup.persistence_failed', { error });
      this.#snapshot = { ...this.#snapshot, resumeAvailable: false, error: 'Setup progress could not be saved. Resume after restart is unavailable.' };
      this.#options.emit(this.#copy());
    });
  }

  #copy(): DesktopSetupSnapshot {
    return redactDesktopValue(structuredClone(this.#snapshot), 0, this.#activeSecrets) as DesktopSetupSnapshot;
  }

  #diagnose(event: string, fields: Record<string, unknown>): void {
    this.#options.diagnose?.(event, redactDesktopValue(fields, 0, this.#activeSecrets) as Record<string, unknown>);
  }
}
