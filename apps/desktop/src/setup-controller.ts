import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, resolve } from 'node:path';
import {
  readPrivateFile,
  rethrowCancellation,
  writePrivateFileAtomic,
  getLocalSetupCapability,
  retrySetup,
  runSetup,
  type GithubAuthDecision,
  type SetupActions,
  type SetupRunResult,
} from '@propr/local-setup';
import { DEFAULT_PROPR_GH_RELAY_URL } from '@propr/shared';
import { redactDesktopValue, safeRendererError } from './secret-redaction';
import { bindRootOperations, RootDirectoryAuthority, SetupFilesystemCapabilities, SetupSecretCapabilities } from './setup-capabilities';
import { parseDesktopSetupRequest, SetupRequestError } from './setup-schema';
import type {
  DesktopFilesystemSelection,
  DesktopProfileView,
  DesktopSetupRequest,
  DesktopSetupResumeView,
  DesktopSetupSnapshot,
  DesktopSecretSelection,
} from './shared/contract';

type ResumePlan = DesktopSetupResumeView;

interface PersistedSetupState {
  version: 3;
  phase: Exclude<DesktopSetupSnapshot['phase'], 'unsupported'>;
  rootDir: string;
  lastStepId?: string;
  resume: ResumePlan;
}

interface ResolvedRequest {
  publicRequest: DesktopSetupRequest;
  rootDir: string;
  privateKeyPath?: string;
  webhookSecret?: string;
  rootAuthority: RootDirectoryAuthority;
}

export interface DesktopSetupControllerOptions {
  actions: SetupActions;
  platform?: NodeJS.Platform;
  statePath: string;
  appDataDir?: string;
  defaultRootDir: string;
  keyStorageDir?: string;
  selectPrivateKey(signal?: AbortSignal): Promise<string | null>;
  promptWebhookSecret?(signal?: AbortSignal): Promise<string | null>;
  resolveApiBaseUrl(rootDir: string, signal?: AbortSignal): Promise<string>;
  registerProfile(profile: { name: string; apiBaseUrl: string }, signal?: AbortSignal): Promise<DesktopProfileView>;
  emit(snapshot: DesktopSetupSnapshot): void;
  diagnose?(event: string, fields: Record<string, unknown>): void;
  sessionId?: string;
}

const PHASES = new Set(['idle', 'running', 'interrupted', 'cancelled', 'failed', 'completed']);
const STEPS = new Set(['check', 'init-stack', 'pull-images', 'configure-agents', 'github-auth', 'intake', 'start-stack', 'enable-agents', 'whitelist', 'repo', 'launch-ui']);

const terminalPhase = (result: SetupRunResult): DesktopSetupSnapshot['phase'] => result.completed ? 'completed' : result.cancelled ? 'cancelled' : 'failed';

const isCleanupIncomplete = (error: unknown): boolean => Boolean(
  error && typeof error === 'object'
  && (error as { code?: unknown }).code === 'PROPR_SETUP_CLEANUP_INCOMPLETE',
);

const cleanupIncompleteRendererError = 'Setup stopped, but local runtime cleanup is incomplete. Review the protected desktop log before retrying.';

const assertPath = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 4_096 && isAbsolute(value) && !value.includes('\0');

const parseResumePlan = (value: unknown): ResumePlan => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid resume plan');
  const plan = value as Record<string, unknown>;
  if (Object.keys(plan).some(key => !['reinitialize', 'agents', 'github', 'intake', 'whitelist', 'repository', 'reconfigurationStage'].includes(key))) throw new Error('Invalid resume plan');
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
    github: github?.mode === 'app'
      ? { mode: 'app', appId: github.appId, installationId: github.installationId, privateKeyCapability: 'A'.repeat(43) }
      : github,
    intake: intake?.mode === 'direct_webhook' ? { mode: 'direct_webhook', secretCapability: 'A'.repeat(43) } : intake,
    whitelist: plan.whitelist,
    repository: plan.repository,
  });
  if (github?.mode === 'app' && github.reconfigurationRequired !== true) throw new Error('Invalid resume plan');
  if (intake?.mode === 'direct_webhook' && intake.reconfigurationRequired !== true) throw new Error('Invalid resume plan');
  const expectedStage = github?.mode === 'app' ? 'github' : intake?.mode === 'direct_webhook' ? 'intake' : undefined;
  if (plan.reconfigurationStage !== expectedStage) throw new Error('Invalid resume plan');
  return {
    reinitialize: synthetic.reinitialize,
    agents: synthetic.agents,
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
  if (!value || value.version !== 3 || !PHASES.has(String(value.phase)) || !assertPath(value.rootDir)) throw new Error('Invalid setup state');
  if (value.lastStepId !== undefined && (typeof value.lastStepId !== 'string' || !STEPS.has(value.lastStepId))) throw new Error('Invalid setup state');
  if (Object.keys(value).some(key => !['version', 'phase', 'rootDir', 'lastStepId', 'resume'].includes(key))) throw new Error('Invalid setup state');
  return {
    version: 3,
    phase: value.phase as PersistedSetupState['phase'],
    rootDir: resolve(value.rootDir as string),
    ...(value.lastStepId ? { lastStepId: value.lastStepId as string } : {}),
    resume: parseResumePlan(value.resume),
  };
};

const resumeView = (plan: ResumePlan): DesktopSetupResumeView => ({
  reinitialize: plan.reinitialize,
  agents: [...plan.agents],
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
  readonly #secrets = new SetupSecretCapabilities();
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

  async selectPrivateKey(signal?: AbortSignal): Promise<DesktopFilesystemSelection | null> {
    signal?.throwIfAborted();
    await this.#load();
    signal?.throwIfAborted();
    this.#enforceCapability(true);
    try {
      const selected = await this.#options.selectPrivateKey(signal);
      signal?.throwIfAborted();
      const issued = selected ? await this.#filesystem.issue('private-key', this.#sessionId, selected, signal) : null;
      signal?.throwIfAborted();
      return issued;
    } catch (error) {
      if (signal?.aborted) signal.throwIfAborted();
      rethrowCancellation(error);
      this.#diagnose('desktop.setup.private_key_selection_failed', { error });
      throw new Error(safeRendererError);
    }
  }

  async acquireWebhookSecret(signal?: AbortSignal): Promise<DesktopSecretSelection | null> {
    signal?.throwIfAborted();
    await this.#load();
    signal?.throwIfAborted();
    this.#enforceCapability(true);
    try {
      if (!this.#options.promptWebhookSecret) throw new SetupRequestError('A secure native secret prompt is unavailable.');
      const value = await this.#options.promptWebhookSecret(signal);
      signal?.throwIfAborted();
      return value === null ? null : this.#secrets.issue(this.#sessionId, value);
    } catch (error) {
      if (signal?.aborted) signal.throwIfAborted();
      rethrowCancellation(error);
      this.#diagnose('desktop.setup.webhook_secret_prompt_failed', { error });
      throw new Error(safeRendererError);
    }
  }

  start(input: unknown, externalSignal?: AbortSignal): Promise<DesktopSetupSnapshot> {
    return this.#begin(parseDesktopSetupRequest(input), false, externalSignal);
  }

  async retry(input?: unknown, externalSignal?: AbortSignal): Promise<DesktopSetupSnapshot> {
    externalSignal?.throwIfAborted();
    await this.#load();
    externalSignal?.throwIfAborted();
    this.#enforceCapability(true);
    if (input !== undefined) return this.#begin(parseDesktopSetupRequest(input), true, externalSignal);
    if (this.#resume?.reconfigurationStage === 'github' || this.#resume?.reconfigurationStage === 'intake') {
      throw new SetupRequestError(`Re-enter the ${this.#resume.reconfigurationStage} configuration before retrying.`);
    }
    if (this.#runtimeRetry) {
      const rootAuthority = RootDirectoryAuthority.open(this.#options.defaultRootDir, true, this.#appDataDir());
      try {
        externalSignal?.throwIfAborted();
        return await this.#beginResolved({ ...this.#runtimeRetry, rootDir: resolve(this.#options.defaultRootDir), rootAuthority }, true, externalSignal);
      } finally {
        if (this.#runtimeRetry?.rootAuthority !== rootAuthority) rootAuthority.close();
      }
    }
    if (!this.#resume) throw new SetupRequestError('There is no local setup to resume');
    if (this.#resume.reconfigurationStage) throw new SetupRequestError(`Re-enter the ${this.#resume.reconfigurationStage} configuration before retrying.`);
    const request = parseDesktopSetupRequest({
      sessionId: this.#sessionId,
      root: { mode: 'resume' },
      reinitialize: this.#resume.reinitialize,
      agents: this.#resume.agents,
      github: this.#resume.github,
      intake: this.#resume.intake,
      whitelist: this.#resume.whitelist,
      repository: this.#resume.repository,
    });
    return this.#begin(request, true, externalSignal);
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
    this.#secrets.clear();
    this.#runtimeRetry?.rootAuthority.close();
  }

  async #begin(request: DesktopSetupRequest, retry: boolean, externalSignal?: AbortSignal): Promise<DesktopSetupSnapshot> {
    externalSignal?.throwIfAborted();
    await this.#load();
    externalSignal?.throwIfAborted();
    this.#enforceCapability(true);
    if (this.#busy || this.#currentRun) throw new SetupRequestError('Local setup is already running');
    this.#busy = true;
    let openedAuthority: RootDirectoryAuthority | undefined;
    try {
      if (request.sessionId !== this.#sessionId) throw new SetupRequestError('The setup session expired. Start again.');
      if (request.github.mode === 'app') {
        await this.#filesystem.validate(request.github.privateKeyCapability, 'private-key', this.#sessionId);
        externalSignal?.throwIfAborted();
      }
      if (request.intake.mode === 'direct_webhook') this.#secrets.validate(request.intake.secretCapability, this.#sessionId);
      if (request.root.mode === 'resume' && !this.#resume) throw new SetupRequestError('There is no local setup to resume.');
      const rootDir = resolve(this.#options.defaultRootDir);
      const rootAuthority = RootDirectoryAuthority.open(rootDir, true, this.#appDataDir());
      openedAuthority = rootAuthority;
      let privateKeyPath: string | undefined;
      if (request.github.mode === 'app') {
        privateKeyPath = await this.#filesystem.consumePrivateKey(
          request.github.privateKeyCapability,
          this.#sessionId,
          this.#options.keyStorageDir ?? `${this.#options.statePath}.keys`,
          externalSignal,
        );
      }
      externalSignal?.throwIfAborted();
      const webhookSecret = request.intake.mode === 'direct_webhook'
        ? this.#secrets.consume(request.intake.secretCapability, this.#sessionId)
        : undefined;
      externalSignal?.throwIfAborted();
      return await this.#beginResolved({ publicRequest: request, rootDir, rootAuthority, privateKeyPath, webhookSecret }, retry, externalSignal);
    } finally {
      if (!this.#currentRun) {
        if (openedAuthority && this.#runtimeRetry?.rootAuthority !== openedAuthority) openedAuthority.close();
        this.#busy = false;
      }
    }
  }

  async #beginResolved(resolved: ResolvedRequest, retry: boolean, externalSignal?: AbortSignal): Promise<DesktopSetupSnapshot> {
    this.#enforceCapability(true);
    if (this.#currentRun) throw new SetupRequestError('Local setup is already running');
    const runController = new AbortController();
    if (externalSignal?.aborted) runController.abort(externalSignal.reason);
    else externalSignal?.addEventListener('abort', () => runController.abort(externalSignal.reason), { once: true });
    runController.signal.throwIfAborted();
    this.#busy = true;
    if (this.#runtimeRetry && this.#runtimeRetry.rootAuthority !== resolved.rootAuthority) this.#runtimeRetry.rootAuthority.close();
    this.#resume = this.#resumePlan(resolved);
    this.#runtimeRetry = resolved;
    this.#activeSecrets = [resolved.privateKeyPath, resolved.webhookSecret].filter((value): value is string => Boolean(value));
    this.#abortController = runController;
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
        resolved.rootAuthority.validate();
        const apiBaseUrl = await this.#options.resolveApiBaseUrl(resolved.rootDir, signal);
        resolved.rootAuthority.validate();
        signal.throwIfAborted();
        profile = await this.#options.registerProfile({ name: 'This computer', apiBaseUrl }, signal);
        signal.throwIfAborted();
      }
      this.#snapshot = { ...this.#snapshot, phase: terminalPhase(result), rootDir: result.rootDir, state: result.state, errors: result.errors, profile };
    } catch (error) {
      const cleanupIncomplete = isCleanupIncomplete(error);
      const cancelled = signal.aborted && !cleanupIncomplete;
      if (!cancelled) this.#diagnose('desktop.setup.run_failed', { error });
      this.#snapshot = {
        ...this.#snapshot,
        phase: cancelled ? 'cancelled' : 'failed',
        error: cancelled ? 'Setup was cancelled.' : cleanupIncomplete ? cleanupIncompleteRendererError : safeRendererError,
      };
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
            return { mode: 'app', vars: { PROPR_DEMO_MODE: 'false', GH_AUTH_MODE: 'app', GH_APP_ID: request.github.appId, HOST_GH_PRIVATE_KEY: resolved.privateKeyPath, GH_INSTALLATION_ID: request.github.installationId } };
        }
      },
      confirmGithubLogin: async () => true,
      confirmGithubAppInstall: async () => true,
      confirmGithubAppInstalled: async () => false,
      configureIntake: async () => request.intake.mode === 'keep' ? { keep: true } : request.intake.mode === 'direct_webhook'
        ? { mode: request.intake.mode, webhookSecret: resolved.webhookSecret }
        : { mode: request.intake.mode },
      confirmStartStack: async () => true,
      confirmAgentLogin: async ({ candidates }: { candidates: string[] }) => candidates.filter(candidate => request.agents.includes(candidate)),
      configureWhitelist: async () => request.whitelist,
      addRepository: async () => request.repository,
      launchUi: async () => false,
    };
  }

  #boundActions(resolved: ResolvedRequest): SetupActions {
    return bindRootOperations(this.#options.actions, resolved.rootDir, resolved.rootAuthority);
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
      reinitialize: request.reinitialize,
      agents: [...request.agents],
      github,
      intake,
      whitelist: request.whitelist ? [...request.whitelist] : null,
      repository: request.repository ? { ...request.repository } : null,
      ...(request.github.mode === 'app' ? { reconfigurationStage: 'github' as const } : request.intake.mode === 'direct_webhook' ? { reconfigurationStage: 'intake' as const } : {}),
    };
  }

  #appDataDir(): string {
    return resolve(this.#options.appDataDir ?? dirname(this.#options.defaultRootDir));
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
      const contents = readPrivateFile(this.#options.statePath);
      if (!contents) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      const parsed = parsePersisted(contents.toString('utf8'));
      if (parsed.rootDir !== resolve(this.#options.defaultRootDir)) throw new Error('Saved setup root is not the fixed desktop runtime root');
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
      version: 3,
      phase: this.#snapshot.phase === 'unsupported' ? 'idle' : this.#snapshot.phase,
      rootDir: resolve(this.#options.defaultRootDir),
      lastStepId: this.#snapshot.state?.steps.find(step => step.status === 'active')?.id,
      resume: this.#resume,
    };
    this.#persistQueue = this.#persistQueue.then(async () => {
      const signal = this.#abortController?.signal;
      signal?.throwIfAborted();
      // PersistedSetupState is an allowlisted, secret-free main-process schema.
      // Keep its fixed root usable for hydration; renderer copies and desktop
      // diagnostics apply path redaction independently.
      writePrivateFileAtomic(this.#options.statePath, `${JSON.stringify(persisted, null, 2)}\n`, { signal });
      this.#snapshot = { ...this.#snapshot, resumeAvailable: true };
    }).catch(error => {
      if ((error as Error).name === 'AbortError' || (error as NodeJS.ErrnoException).code === 'ABORT_ERR') return;
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
