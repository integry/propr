import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  getLocalSetupCapability, retrySetup, runSetup,
  type GithubAuthDecision, type RelayInstallationChoiceContext, type RelayInstallationDecision,
  type SetupActions, type SetupRunResult,
} from '@propr/local-setup';
import { DEFAULT_PROPR_GH_RELAY_URL, PROPR_API_COMPATIBILITY } from '@propr/shared';
import { bindRootOperations, RootDirectoryAuthority, SetupFilesystemCapabilities, SetupSecretCapabilities } from './setup-capabilities';
import { parseDesktopSetupRecoveryRequest, parseDesktopSetupRequest, SetupRequestError } from './setup-schema';
import type {
  DesktopFilesystemSelection, DesktopSecretSelection, DesktopSetupRequest,
  DesktopGithubInstallation, DesktopGithubInstallationDecision, DesktopSetupResumeView, DesktopSetupSnapshot,
} from './shared/contract';

interface ResolvedRequest {
  request: DesktopSetupRequest;
  authority: RootDirectoryAuthority;
  privateKeyPath?: string;
  webhookSecret?: string;
}

interface PersistedSetup {
  version: 1 | 2;
  phase: 'running' | 'cancelled' | 'failed' | 'completed';
  resume: DesktopSetupResumeView;
  profile?: DesktopSetupSnapshot['profile'];
  /** Present only after the pre-completion desktop runtime gate succeeded. */
  apiCompatibility?: string;
}

export interface DesktopSetupControllerOptions {
  actions: SetupActions;
  platform?: NodeJS.Platform;
  appDataDir: string;
  defaultRootDir: string;
  statePath: string;
  selectPrivateKey(signal?: AbortSignal): Promise<string | null>;
  promptWebhookSecret(signal?: AbortSignal): Promise<string | null>;
  resolveApiBaseUrl(rootDir: string, signal?: AbortSignal): Promise<string>;
  emit(snapshot: DesktopSetupSnapshot): void;
  diagnose?(event: string, fields?: Record<string, unknown>): void;
  sessionId?: string;
}

const copyResume = (value: DesktopSetupResumeView): DesktopSetupResumeView => structuredClone(value);
const SETUP_PHASES = new Set<PersistedSetup['phase']>(['running', 'cancelled', 'failed', 'completed']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const validCompletedProfile = (value: unknown): value is NonNullable<DesktopSetupSnapshot['profile']> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const profile = value as Record<string, unknown>;
  if (Object.keys(profile).some(key => !['id', 'name', 'baseUrl', 'kind'].includes(key))
    || typeof profile.id !== 'string' || !UUID.test(profile.id)
    || typeof profile.name !== 'string' || profile.name.length === 0 || profile.name.length > 100
    || profile.kind !== 'local' || typeof profile.baseUrl !== 'string' || profile.baseUrl.length > 2048) return false;
  try {
    const url = new URL(profile.baseUrl);
    return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      && Boolean(url.port) && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/';
  } catch { return false; }
};

const validGithubSelectedIdentity = (value: unknown): boolean => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const identity = value as Record<string, unknown>;
  if (Object.keys(identity).some(key => !['username', 'installation'].includes(key))
    || typeof identity.username !== 'string'
    || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(identity.username)
    || !identity.installation || typeof identity.installation !== 'object' || Array.isArray(identity.installation)) return false;
  const installation = identity.installation as Record<string, unknown>;
  return !Object.keys(installation).some(key => !['installationId', 'accountLogin', 'accountType'].includes(key))
    && typeof installation.installationId === 'string' && /^[1-9][0-9]{0,19}$/.test(installation.installationId)
    && typeof installation.accountLogin === 'string'
    && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(installation.accountLogin)
    && (installation.accountType === 'User' || installation.accountType === 'Organization');
};

const enforceDesktopResumePolicy = (value: DesktopSetupResumeView): {
  resume: DesktopSetupResumeView;
  message?: string;
} => {
  const resume = copyResume(value);
  if (resume.github.mode === 'demo') {
    resume.reconfigurationStage = 'github';
    return {
      resume,
      message: 'Demo mode is no longer available in desktop setup. Review saved choices and select ProPR Connect or Custom GitHub App.',
    };
  }
  if (resume.github.mode === 'relay' && resume.intake.mode !== 'routing_websocket') {
    resume.intake = { mode: 'routing_websocket' };
    resume.reconfigurationStage = 'intake';
    return {
      resume,
      message: 'ProPR Connect now requires WebSocket intake. Review and confirm the corrected saved choice before retrying.',
    };
  }
  return { resume };
};

export class DesktopSetupController {
  readonly #options: DesktopSetupControllerOptions;
  readonly #sessionId: string;
  readonly #filesystem = new SetupFilesystemCapabilities();
  readonly #secrets = new SetupSecretCapabilities();
  #snapshot: DesktopSetupSnapshot;
  #abort: AbortController | null = null;
  #current: Promise<DesktopSetupSnapshot> | null = null;
  #result: SetupRunResult | null = null;
  #resolved: ResolvedRequest | null = null;
  #resume: DesktopSetupResumeView | null = null;
  #loaded = false;
  #pendingGithub: { resolve(value: RelayInstallationDecision): void; settled: boolean } | null = null;

  constructor(options: DesktopSetupControllerOptions) {
    this.#options = options;
    this.#sessionId = options.sessionId ?? randomUUID();
    const capability = getLocalSetupCapability(options.platform ?? process.platform);
    this.#snapshot = {
      phase: capability.supported ? 'idle' : 'unsupported', capability,
      sessionId: this.#sessionId, logs: [], resumeAvailable: false,
      ...(capability.supported ? {} : { error: capability.reason }),
    };
  }

  async status(): Promise<DesktopSetupSnapshot> { this.#load(); return this.#publicSnapshot(); }

  async selectPrivateKey(signal?: AbortSignal): Promise<DesktopFilesystemSelection | null> {
    this.#assertSupported(); signal?.throwIfAborted();
    const selected = await this.#options.selectPrivateKey(signal);
    return selected ? this.#filesystem.issue(this.#sessionId, selected, signal) : null;
  }

  async acquireWebhookSecret(signal?: AbortSignal): Promise<DesktopSecretSelection | null> {
    this.#assertSupported(); signal?.throwIfAborted();
    const value = await this.#options.promptWebhookSecret(signal);
    return value === null ? null : this.#secrets.issue(this.#sessionId, value);
  }

  async resolveGithubInstallation(input: unknown): Promise<DesktopSetupSnapshot> {
    const pending = this.#pendingGithub;
    if (!pending || pending.settled) throw new SetupRequestError('No GitHub installation choice is pending.');
    const decision = this.#parseGithubDecision(input);
    const identity = this.#snapshot.githubIdentity;
    if (!identity || !['selection-required', 'authorization-failed'].includes(identity.status)) {
      throw new SetupRequestError('The GitHub installation choice is no longer active.');
    }
    if (decision.action === 'select') {
      const installation = identity.installations.find(item => item.installationId === decision.installationId);
      if (!installation) throw new SetupRequestError('Choose an installation from the current discovered list.');
      if (this.#resume?.github.mode === 'relay') {
        this.#resume.github.identity = { username: identity.username, installation: { ...installation } };
      }
      this.#snapshot = { ...this.#snapshot, githubIdentity: {
        ...identity, status: 'enrolling', selectedInstallationId: installation.installationId,
        permissionExplanation: undefined,
      }, ...(this.#resume ? { resume: copyResume(this.#resume) } : {}) };
    } else {
      if (decision.action === 'install' && !identity.installAvailable) throw new SetupRequestError('GitHub App installation is unavailable for this relay.');
      if (decision.action === 'reauthenticate' && this.#resume?.github.mode === 'relay') delete this.#resume.github.identity;
      this.#snapshot = { ...this.#snapshot, githubIdentity: { ...identity,
        status: decision.action === 'refresh' ? 'refreshing' : decision.action === 'install' ? 'installing' : 'reauthenticating',
        permissionExplanation: undefined,
      }, ...(this.#resume ? { resume: copyResume(this.#resume) } : {}) };
    }
    this.#publish();
    pending.resolve(decision);
    return this.#publicSnapshot();
  }

  start(input: unknown): Promise<DesktopSetupSnapshot> { return this.#begin(parseDesktopSetupRequest(input), false); }

  async retry(input?: unknown): Promise<DesktopSetupSnapshot> {
    this.#load(); this.#assertSupported();
    if (input !== undefined) {
      if (typeof input === 'object' && input !== null && 'recoveryAction' in input) {
        const recovery = parseDesktopSetupRecoveryRequest(input);
        if (recovery.sessionId !== this.#sessionId) throw new SetupRequestError('The setup session expired. Start again.');
        const failed = this.#snapshot.state?.steps.find(step => step.status === 'failed');
        if (failed?.recoveryAction !== recovery.recoveryAction) throw new SetupRequestError('The requested recovery is unavailable.');
        return this.#retrySaved(true);
      }
      const request = parseDesktopSetupRequest(input);
      if (this.#resume?.github.mode === 'demo' && request.github.mode === 'keep') {
        throw new SetupRequestError('Select ProPR Connect or Custom GitHub App before retrying a legacy Demo configuration.');
      }
      return this.#begin(request, true, false);
    }
    return this.#retrySaved(false);
  }

  #retrySaved(replaceRunningStack: boolean): Promise<DesktopSetupSnapshot> {
    if (this.#current) throw new SetupRequestError('Local setup is already running.');
    if (!this.#resume) throw new SetupRequestError('There is no local setup to retry.');
    if (!this.#resolved) {
      if (this.#resume.reconfigurationStage) throw new SetupRequestError(`Re-enter the ${this.#resume.reconfigurationStage} configuration before retrying.`);
      const request = parseDesktopSetupRequest({
        sessionId: this.#sessionId, root: { mode: 'resume' }, reinitialize: this.#resume.reinitialize,
        agents: this.#resume.agents,
        github: this.#resume.github.mode === 'relay' ? { mode: 'relay' } : this.#resume.github,
        intake: this.#resume.intake,
        whitelist: this.#resume.whitelist, repository: this.#resume.repository,
      });
      return this.#begin(request, true, replaceRunningStack);
    }
    return this.#runResolved(this.#resolved, true, replaceRunningStack);
  }

  async cancel(): Promise<DesktopSetupSnapshot> {
    this.#settleGithubChoice();
    this.#abort?.abort();
    await this.#current?.catch(() => undefined);
    return this.#publicSnapshot();
  }

  async shutdown(): Promise<void> {
    this.#settleGithubChoice();
    this.#abort?.abort();
    await this.#current?.catch(() => undefined);
    this.#filesystem.clear(); this.#secrets.clear(); this.#resolved?.authority.close();
  }

  async #begin(request: DesktopSetupRequest, retry: boolean, replaceRunningStack = false): Promise<DesktopSetupSnapshot> {
    this.#load(); this.#assertSupported();
    if (this.#current) throw new SetupRequestError('Local setup is already running.');
    if (request.sessionId !== this.#sessionId) throw new SetupRequestError('The setup session expired. Start again.');
    const authority = RootDirectoryAuthority.open(this.#options.defaultRootDir, this.#options.appDataDir);
    return this.#admit(signal => this.#resolveAndRun(request, authority, retry, replaceRunningStack, signal));
  }

  async #resolveAndRun(request: DesktopSetupRequest, authority: RootDirectoryAuthority, retry: boolean, replaceRunningStack: boolean, signal: AbortSignal): Promise<DesktopSetupSnapshot> {
    try {
      const privateKeyPath = request.github.mode === 'app'
        ? await this.#filesystem.consume(request.github.privateKeyCapability, this.#sessionId, `${this.#options.statePath}.keys`, signal)
        : undefined;
      signal.throwIfAborted();
      const webhookSecret = request.intake.mode === 'direct_webhook'
        ? this.#secrets.consume(request.intake.secretCapability, this.#sessionId, signal) : undefined;
      const resolved = { request, authority, privateKeyPath, webhookSecret };
      if (this.#resolved?.authority !== authority) this.#resolved?.authority.close();
      this.#resolved = resolved;
      this.#resume = this.#resumeFrom(request);
      return await this.#executeResolved(resolved, retry, replaceRunningStack, signal);
    } catch (error) {
      if (this.#resolved?.authority !== authority) authority.close();
      if (signal.aborted || (error as Error).name === 'AbortError') {
        this.#resume = this.#resumeFrom(request);
        this.#snapshot = {
          phase: 'cancelled', capability: getLocalSetupCapability(this.#options.platform ?? process.platform),
          sessionId: this.#sessionId, logs: [], resume: copyResume(this.#resume), resumeAvailable: true,
          reconfigurationRequired: Boolean(this.#resume.reconfigurationStage), error: 'Setup was cancelled safely.',
        };
        this.#publish();
        return this.#publicSnapshot();
      }
      throw error;
    }
  }

  #runResolved(resolved: ResolvedRequest, retry: boolean, replaceRunningStack = false): Promise<DesktopSetupSnapshot> {
    if (this.#current) throw new SetupRequestError('Local setup is already running.');
    return this.#admit(signal => this.#executeResolved(resolved, retry, replaceRunningStack, signal));
  }

  #admit(run: (signal: AbortSignal) => Promise<DesktopSetupSnapshot>): Promise<DesktopSetupSnapshot> {
    const controller = new AbortController();
    this.#abort = controller;
    const operation = Promise.resolve().then(() => run(controller.signal));
    this.#current = operation;
    const cleanup = () => { if (this.#current === operation) { this.#current = null; this.#abort = null; } };
    void operation.then(cleanup, cleanup);
    return operation;
  }

  #executeResolved(resolved: ResolvedRequest, retry: boolean, replaceRunningStack: boolean, signal: AbortSignal): Promise<DesktopSetupSnapshot> {
    const reconfigurationRequired = Boolean(this.#resume?.reconfigurationStage);
    this.#snapshot = {
      phase: 'running', capability: getLocalSetupCapability(this.#options.platform ?? process.platform),
      sessionId: this.#sessionId, logs: retry ? ['Retrying setup with a fresh host inspection…'] : [],
      resume: copyResume(this.#resume!), resumeAvailable: true, reconfigurationRequired,
    };
    this.#publish();
    return this.#execute(resolved, retry, replaceRunningStack, signal);
  }

  async #execute(resolved: ResolvedRequest, retry: boolean, replaceRunningStack: boolean, signal: AbortSignal): Promise<DesktopSetupSnapshot> {
    const reporter = {
      onState: (state: SetupRunResult['state']) => { this.#snapshot = { ...this.#snapshot, state }; this.#publish(); },
      onLog: (line: string) => { this.#snapshot = { ...this.#snapshot, logs: [...this.#snapshot.logs, line].slice(-200) }; this.#publish(); },
    };
    try {
      const actions = bindRootOperations(this.#options.actions, resolved.authority);
      const options = { actions, prompts: this.#prompts(resolved, replaceRunningStack, signal), reporter, platform: this.#options.platform ?? process.platform, signal };
      const result = retry && this.#result ? await retrySetup(this.#result, options) : await runSetup({ ...options, root: this.#options.defaultRootDir });
      this.#result = result;
      signal.throwIfAborted();
      let profile: DesktopSetupSnapshot['profile'];
      if (result.completed) {
        resolved.authority.validate();
        const baseUrl = await this.#options.resolveApiBaseUrl(this.#options.defaultRootDir, signal);
        signal.throwIfAborted(); resolved.authority.validate();
        profile = { id: randomUUID(), name: 'This computer', baseUrl, kind: 'local' };
      }
      this.#snapshot = {
        ...this.#snapshot, phase: result.completed ? 'completed' : result.cancelled ? 'cancelled' : 'failed',
        state: result.state, errors: result.errors, profile,
        ...(result.completed && this.#snapshot.githubIdentity ? {
          githubIdentity: { ...this.#snapshot.githubIdentity, status: 'enrolled' as const },
        } : {}),
        reconfigurationRequired: !result.completed && Boolean(this.#resume?.reconfigurationStage),
      };
    } catch (error) {
      const cancelled = signal.aborted || (error as Error).name === 'AbortError';
      if (!cancelled) this.#options.diagnose?.('desktop.setup.run_failed', { name: (error as Error).name });
      this.#snapshot = { ...this.#snapshot, phase: cancelled ? 'cancelled' : 'failed',
        reconfigurationRequired: Boolean(this.#resume?.reconfigurationStage), error: cancelled
          ? 'Setup was cancelled safely.' : 'Local setup failed unexpectedly. Review the protected desktop log for details.' };
    }
    this.#publish();
    return this.#publicSnapshot();
  }

  #prompts(resolved: ResolvedRequest, replaceRunningStack: boolean, signal: AbortSignal) {
    const request = resolved.request;
    return {
      resolveStackRoot: async () => ({ rootDir: this.#options.defaultRootDir, reinitialize: request.reinitialize }),
      selectAgents: async () => [...request.agents],
      configureGithubAuth: async (): Promise<GithubAuthDecision> => {
        if (request.github.mode === 'keep') return { keep: true };
        if (request.github.mode === 'relay') return { mode: 'relay', enrollRelay: { relayUrl: DEFAULT_PROPR_GH_RELAY_URL } };
        if (!resolved.privateKeyPath) throw new SetupRequestError('Select the GitHub App private key again.');
        return { mode: 'app', vars: { PROPR_DEMO_MODE: 'false', GH_AUTH_MODE: 'app', GH_APP_ID: request.github.appId,
          HOST_GH_PRIVATE_KEY: resolved.privateKeyPath, GH_INSTALLATION_ID: request.github.installationId } };
      },
      confirmGithubLogin: async () => true,
      confirmGithubAppInstall: async () => true,
      chooseInstallation: (context: RelayInstallationChoiceContext) => this.#chooseGithubInstallation(context, signal),
      configureIntake: async () => request.intake.mode === 'keep' ? { keep: true as const }
        : request.intake.mode === 'direct_webhook' ? { mode: 'direct_webhook' as const, webhookSecret: resolved.webhookSecret }
        : { mode: request.intake.mode },
      confirmStartStack: async () => true,
      confirmReplaceRunningStack: async () => replaceRunningStack,
      confirmAgentLogin: async ({ candidates }: { candidates: string[] }) => candidates.filter(value => request.agents.includes(value)),
      configureWhitelist: async () => request.whitelist,
      addRepository: async () => request.repository,
      launchUi: async () => false,
    };
  }

  #chooseGithubInstallation(context: RelayInstallationChoiceContext, signal: AbortSignal): Promise<RelayInstallationDecision> {
    if (this.#pendingGithub) throw new SetupRequestError('A GitHub installation choice is already pending.');
    const username = context.username.trim();
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(username)) {
      throw new SetupRequestError('The relay returned an invalid GitHub identity.');
    }
    const installations: DesktopGithubInstallation[] = context.installations.map(item => {
      const installationId = String(item.installation_id);
      const accountLogin = item.account_login.trim();
      const accountType = item.account_type.trim();
      if (!/^[1-9][0-9]{0,19}$/.test(installationId)
        || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(accountLogin)
        || (accountType !== 'User' && accountType !== 'Organization')) {
        throw new SetupRequestError('The relay returned invalid GitHub installation metadata.');
      }
      return { installationId, accountLogin, accountType };
    });
    if (new Set(installations.map(item => item.installationId)).size !== installations.length) {
      throw new SetupRequestError('The relay returned duplicate GitHub installations.');
    }
    const remembered = this.#resume?.github.mode === 'relay' ? this.#resume.github.identity : undefined;
    if (remembered && (remembered.username !== username || !installations.some(
      item => item.installationId === remembered.installation.installationId
    )) && this.#resume?.github.mode === 'relay') delete this.#resume.github.identity;
    const saved = this.#resume?.github.mode === 'relay' && this.#resume.github.identity?.username === username
      ? this.#resume.github.identity.installation.installationId : undefined;
    const selectedInstallationId = [context.selectedInstallationId, saved]
      .find(value => value && installations.some(item => item.installationId === value));
    const permissionExplanation = context.enrollmentPermissionError?.slice(0, 1_000);
    this.#snapshot = { ...this.#snapshot, ...(this.#resume ? { resume: copyResume(this.#resume) } : {}), githubIdentity: {
      status: permissionExplanation ? 'authorization-failed' : 'selection-required',
      username, installations, installAvailable: Boolean(context.installUrl),
      ...(selectedInstallationId ? { selectedInstallationId } : {}),
      ...(permissionExplanation ? { permissionExplanation } : {}),
    } };
    this.#publish();

    return new Promise(resolve => {
      const pending = { settled: false, resolve: (_decision: RelayInstallationDecision): void => undefined };
      const finish = (decision: RelayInstallationDecision): void => {
        if (pending.settled) return;
        pending.settled = true;
        signal.removeEventListener('abort', abort);
        if (this.#pendingGithub === pending) this.#pendingGithub = null;
        resolve(decision);
      };
      const abort = (): void => finish({ action: 'cancel' });
      pending.resolve = finish;
      this.#pendingGithub = pending;
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    });
  }

  #parseGithubDecision(input: unknown): DesktopGithubInstallationDecision {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new SetupRequestError('Invalid GitHub installation action.');
    }
    const value = input as Record<string, unknown>;
    if (value.action === 'select') {
      if (Object.keys(value).some(key => !['action', 'installationId'].includes(key))
        || typeof value.installationId !== 'string' || !/^[1-9][0-9]{0,19}$/.test(value.installationId)) {
        throw new SetupRequestError('Invalid GitHub installation selection.');
      }
      return { action: 'select', installationId: value.installationId };
    }
    if (!['refresh', 'install', 'reauthenticate'].includes(String(value.action)) || Object.keys(value).length !== 1) {
      throw new SetupRequestError('Invalid GitHub installation action.');
    }
    return { action: value.action as 'refresh' | 'install' | 'reauthenticate' };
  }

  #settleGithubChoice(): void {
    this.#pendingGithub?.resolve({ action: 'cancel' });
  }

  #resumeFrom(request: DesktopSetupRequest): DesktopSetupResumeView {
    const github: DesktopSetupResumeView['github'] = request.github.mode === 'app'
      ? { mode: 'app', appId: request.github.appId, installationId: request.github.installationId, reconfigurationRequired: true }
      : request.github.mode === 'relay'
        ? { mode: 'relay', ...(this.#resume?.github.mode === 'relay' && this.#resume.github.identity
          ? { identity: structuredClone(this.#resume.github.identity) } : {}) }
        : structuredClone(request.github);
    const intake: DesktopSetupResumeView['intake'] = request.intake.mode === 'direct_webhook'
      ? { mode: 'direct_webhook', reconfigurationRequired: true } : structuredClone(request.intake);
    return { agents: [...request.agents], reinitialize: request.reinitialize, github, intake,
      whitelist: request.whitelist ? [...request.whitelist] : null,
      repository: request.repository ? { ...request.repository } : null,
      ...(request.github.mode === 'app' ? { reconfigurationStage: 'github' as const }
        : request.intake.mode === 'direct_webhook' ? { reconfigurationStage: 'intake' as const } : {}) };
  }

  #load(): void {
    if (this.#loaded) return; this.#loaded = true;
    try {
      const persisted = JSON.parse(readFileSync(this.#options.statePath, 'utf8')) as PersistedSetup;
      if (![1, 2].includes(persisted.version) || !persisted.resume || !SETUP_PHASES.has(persisted.phase)) throw new Error('invalid');
      const policy = enforceDesktopResumePolicy(persisted.resume);
      if (policy.resume.github.mode === 'relay' && policy.resume.github.identity
        && !validGithubSelectedIdentity(policy.resume.github.identity)) delete policy.resume.github.identity;
      this.#resume = policy.resume;
      const completedProfile = persisted.version === 2
        && persisted.apiCompatibility === PROPR_API_COMPATIBILITY
        && persisted.phase === 'completed' && !policy.message && validCompletedProfile(persisted.profile)
        ? structuredClone(persisted.profile) : undefined;
      const restorationFailed = persisted.phase === 'completed' && !completedProfile && !policy.message;
      this.#snapshot = { ...this.#snapshot,
        phase: persisted.phase === 'running' || restorationFailed || Boolean(policy.message) ? 'interrupted' : persisted.phase,
        resume: copyResume(policy.resume), resumeAvailable: true,
        reconfigurationRequired: !completedProfile && Boolean(policy.resume.reconfigurationStage),
        ...(completedProfile ? { profile: completedProfile } : {}),
        ...(policy.message && !completedProfile ? { error: policy.message }
          : persisted.phase === 'running' ? { error: 'Setup was interrupted. Review the saved choices to continue.' }
            : restorationFailed ? { error: 'Completed setup could not be restored. Review the saved choices to recover.' } : {}) };
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.#options.diagnose?.('desktop.setup.hydration_failed'); }
  }

  #persist(): void {
    if (!this.#resume || this.#snapshot.phase === 'idle' || this.#snapshot.phase === 'unsupported') return;
    const value: PersistedSetup = { version: 2,
      phase: this.#snapshot.phase === 'interrupted' ? 'running' : this.#snapshot.phase,
      resume: this.#resume,
      ...(this.#snapshot.phase === 'completed' ? { apiCompatibility: PROPR_API_COMPATIBILITY } : {}),
      ...(this.#snapshot.phase === 'completed' && this.#snapshot.profile ? { profile: this.#snapshot.profile } : {}),
    };
    const path = this.#options.statePath; const temp = `${path}.tmp`;
    try { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); writeFileSync(temp, `${JSON.stringify(value)}\n`, { mode: 0o600 }); renameSync(temp, path); }
    catch { try { unlinkSync(temp); } catch { /* not created */ } this.#snapshot = { ...this.#snapshot, resumeAvailable: false }; }
  }

  #publish(): void { this.#persist(); this.#options.emit(this.#publicSnapshot()); }
  #assertSupported(): void {
    const capability = getLocalSetupCapability(this.#options.platform ?? process.platform);
    if (!capability.supported) throw new SetupRequestError(capability.reason);
  }
  #publicSnapshot(): DesktopSetupSnapshot {
    const root = resolve(this.#options.defaultRootDir);
    const secretValues = [this.#resolved?.privateKeyPath, this.#resolved?.webhookSecret].filter((value): value is string => Boolean(value));
    const scrub = (value: unknown): unknown => {
      if (typeof value === 'string') {
        let result = value.split(root).join('[LOCAL_RUNTIME]');
        for (const secret of secretValues) result = result.split(secret).join('[REDACTED]');
        return result.replace(/\bgh[pousr]_[A-Za-z0-9_]{8,}\b/g, '[REDACTED]').slice(0, 8192);
      }
      if (Array.isArray(value)) return value.map(scrub);
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key,
        /(?:token|secret|password|private.?key)/i.test(key) ? '[REDACTED]' : scrub(item)]));
      return value;
    };
    return scrub(structuredClone(this.#snapshot)) as DesktopSetupSnapshot;
  }
}
