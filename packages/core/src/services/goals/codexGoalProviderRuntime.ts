import crypto from 'node:crypto';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { AgentConfig } from '../../agents/types.js';
import {
  CodexAppServerClient,
  CodexAppServerStdioTransport,
  type CodexNotification,
} from './codexAppServerClient.js';
import type { ThreadGoal } from './codexAppServerGoalBindings.generated.js';
import { GoalDockerContainerManager, type GoalDockerContainer } from './goalDockerContainer.js';
import type {
  GoalProviderRuntime,
  GoalRuntimeAuthority,
  GoalRuntimeExecution,
  GoalRuntimeRequest,
  GoalRuntimeResult,
  GoalSteeringRequest,
} from './goalRuntimeTypes.js';

type ClientFactory = (container: GoalDockerContainer) => CodexAppServerClient;
interface CodexRuntimeOptions { identityRoot?: string; createClient?: ClientFactory }

interface ExternalIdentity { executionId: string; threadId: string; containerId: string }
interface LiveSession {
  client: CodexAppServerClient;
  threadId: string;
  containerId: string;
  activeTurnId: string | null;
  completion: Promise<void>;
  complete(): void;
  eventChain: Promise<void>;
  unsubscribe: () => void;
}

export class CodexGoalProviderRuntime implements GoalProviderRuntime {
  private readonly sessions = new Map<string, LiveSession>();

  constructor(
    private readonly config: AgentConfig,
    private readonly containers: GoalDockerContainerManager,
    private readonly resolveGithubToken: () => Promise<string>,
    options: CodexRuntimeOptions = {}
  ) {
    this.identityRoot = options.identityRoot ?? process.env.PROPR_GOAL_SESSION_STATE_DIR
      ?? '/tmp/git-processor/goal-native-sessions';
    this.createClient = options.createClient ?? (container => new CodexAppServerClient(
      new CodexAppServerStdioTransport(container.id)
    ));
  }

  private readonly identityRoot: string;
  private readonly createClient: ClientFactory;

  start(request: GoalRuntimeRequest): Promise<GoalRuntimeResult> {
    return this.run(request, false);
  }

  resume(request: GoalRuntimeRequest): Promise<GoalRuntimeResult> {
    return this.run(request, true);
  }

  async steer(request: GoalSteeringRequest): Promise<{ acknowledged: boolean }> {
    await request.authority.assertCurrent();
    const session = this.requireSession(request.execution.executionId);
    const input = textInput(request.body);
    if (session.activeTurnId) {
      await session.client.request('turn/steer', {
        threadId: session.threadId,
        expectedTurnId: session.activeTurnId,
        clientUserMessageId: request.providerMessageId,
        input,
      });
    } else {
      const response = await session.client.request('turn/start', {
        threadId: session.threadId,
        clientUserMessageId: request.providerMessageId,
        input,
      });
      session.activeTurnId = response.turn.id;
    }
    return { acknowledged: true };
  }

  async pause(execution: GoalRuntimeExecution, authority: GoalRuntimeAuthority): Promise<void> {
    await authority.assertCurrent();
    const session = this.requireSession(execution.executionId);
    await session.client.request('thread/goal/set', { threadId: session.threadId, status: 'paused' });
    await this.interrupt(session);
  }

  async cancel(execution: GoalRuntimeExecution, authority: GoalRuntimeAuthority): Promise<void> {
    await authority.assertCurrent();
    const session = await this.adoptForControl(execution);
    await session.client.request('thread/goal/clear', { threadId: session.threadId });
    await this.interrupt(session);
  }

  async changeModel(
    execution: GoalRuntimeExecution,
    model: string,
    authority: GoalRuntimeAuthority
  ): Promise<{ effectiveModel: string }> {
    await authority.assertCurrent();
    const session = await this.adoptForControl(execution);
    await session.client.request('thread/settings/update', { threadId: session.threadId, model });
    const resumed = await session.client.request('thread/resume', resumeParams(session.threadId));
    if (resumed.model !== model) throw new Error(`Codex acknowledged model '${resumed.model}', expected '${model}'`);
    return { effectiveModel: resumed.model };
  }

  async settle(execution: GoalRuntimeExecution, authority: GoalRuntimeAuthority): Promise<void> {
    await authority.assertCurrent();
    const session = this.sessions.get(execution.executionId);
    if (!session) return;
    await session.completion;
    await session.eventChain;
    session.unsubscribe();
    await session.client.close();
    this.sessions.delete(execution.executionId);
  }

  async terminate(execution: GoalRuntimeExecution, authority: GoalRuntimeAuthority): Promise<void> {
    await authority.assertCurrent();
    const session = this.sessions.get(execution.executionId);
    if (session) {
      session.unsubscribe();
      await session.client.close().catch(() => undefined);
      this.sessions.delete(execution.executionId);
    }
    if (execution.runtimeId) await this.containers.terminate(execution.runtimeId);
  }

  private async run(request: GoalRuntimeRequest, resume: boolean): Promise<GoalRuntimeResult> {
    await request.authority.assertCurrent();
    const session = await this.open(request);
    await request.callbacks.onSessionIdentity({
      providerSessionId: session.threadId,
      providerThreadId: session.threadId,
      runtimeId: session.containerId,
      worktreeId: request.execution.workspace.worktreeId,
    });
    const response = await session.client.request('turn/start', {
      threadId: session.threadId,
      clientUserMessageId: `propr:${request.execution.executionId}:${resume ? 'resume' : 'start'}`,
      input: textInput(resume
        ? 'Continue the active native goal from its durable provider checkpoint.'
        : request.command),
    });
    session.activeTurnId = response.turn.id;
    await session.completion;
    await session.eventChain;
    const { goal } = await session.client.request('thread/goal/get', { threadId: session.threadId });
    return goalResult(goal);
  }

  private async open(request: GoalRuntimeRequest): Promise<LiveSession> {
    const existingLive = this.sessions.get(request.execution.executionId);
    if (existingLive) return existingLive;
    const container = await this.containers.ensure(
      request.execution,
      this.config,
      await this.resolveGithubToken()
    );
    const client = this.createClient(container);
    await client.initialize();
    const external = await this.readIdentity(request.execution.executionId);
    let threadId: string;
    if (external) {
      if (external.containerId !== container.id) throw new Error('Codex goal container identity changed');
      const resumed = await client.request('thread/resume', resumeParams(external.threadId));
      threadId = resumed.thread.id;
      const { goal } = await client.request('thread/goal/get', { threadId });
      if (!goal || goal.objective !== request.goal.objective) {
        throw new Error('Persisted Codex thread does not contain the expected native goal');
      }
    } else {
      const started = await client.request('thread/start', {
        model: request.execution.effectiveModel,
        cwd: '/home/node/workspace', runtimeWorkspaceRoots: ['/home/node/workspace'],
        approvalPolicy: 'never', sandbox: 'danger-full-access', ephemeral: false,
        historyMode: 'paginated',
      });
      threadId = started.thread.id;
      await client.request('thread/goal/set', {
        threadId, objective: request.goal.objective, status: 'active',
      });
      // This external identity is written before SQL callback. Re-entry after a
      // crash adopts the same App Server thread instead of starting a duplicate.
      await this.writeIdentity({ executionId: request.execution.executionId, threadId, containerId: container.id });
    }
    const session = createLiveSession(client, threadId, container.id, request);
    this.sessions.set(request.execution.executionId, session);
    return session;
  }

  private async adoptForControl(execution: GoalRuntimeExecution): Promise<LiveSession> {
    const live = this.sessions.get(execution.executionId);
    if (live) return live;
    if (!execution.runtimeId || !execution.providerThreadId) throw new Error('Codex session identity is missing');
    const client = this.createClient({ id: execution.runtimeId, name: execution.runtimeId });
    await client.initialize();
    await client.request('thread/resume', resumeParams(execution.providerThreadId));
    const session = createIdleSession(client, execution.providerThreadId, execution.runtimeId);
    this.sessions.set(execution.executionId, session);
    return session;
  }

  private async interrupt(session: LiveSession): Promise<void> {
    if (!session.activeTurnId) return;
    await session.client.request('turn/interrupt', {
      threadId: session.threadId, turnId: session.activeTurnId,
    });
  }

  private requireSession(executionId: string): LiveSession {
    const session = this.sessions.get(executionId);
    if (!session) throw new Error('Codex goal session is not attached');
    return session;
  }

  private identityPath(executionId: string): string {
    const name = crypto.createHash('sha256').update(executionId).digest('hex');
    return path.join(this.identityRoot, `${name}.json`);
  }

  private async readIdentity(executionId: string): Promise<ExternalIdentity | null> {
    try {
      return JSON.parse(await fs.readFile(this.identityPath(executionId), 'utf8')) as ExternalIdentity;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  private async writeIdentity(identity: ExternalIdentity): Promise<void> {
    await fs.mkdir(this.identityRoot, { recursive: true, mode: 0o700 });
    const target = this.identityPath(identity.executionId);
    const temporary = `${target}.${process.pid}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(identity), { mode: 0o600 });
    await fs.rename(temporary, target);
  }
}

function createLiveSession(
  client: CodexAppServerClient,
  threadId: string,
  containerId: string,
  request: GoalRuntimeRequest
): LiveSession {
  let complete!: () => void;
  const session: LiveSession = {
    client, threadId, containerId, activeTurnId: null,
    completion: new Promise<void>(resolve => { complete = resolve; }),
    complete: () => complete(), eventChain: Promise.resolve(), unsubscribe: () => undefined,
  };
  session.unsubscribe = client.onNotification(notification => {
    session.eventChain = session.eventChain.then(() => projectNotification(notification, session, request));
    if (notification.method === 'turn/completed') {
      session.activeTurnId = null;
      session.complete();
    }
  });
  return session;
}

function createIdleSession(client: CodexAppServerClient, threadId: string, containerId: string): LiveSession {
  return {
    client, threadId, containerId, activeTurnId: null,
    completion: Promise.resolve(), complete: () => undefined,
    eventChain: Promise.resolve(), unsubscribe: () => undefined,
  };
}

async function projectNotification(
  notification: CodexNotification,
  session: LiveSession,
  request: GoalRuntimeRequest
): Promise<void> {
  const params = notification.params ?? {};
  const turn = params.turn as { id?: unknown } | undefined;
  if (notification.method === 'turn/started' && typeof turn?.id === 'string') {
    session.activeTurnId = turn.id;
  }
  const method = notification.method.toLowerCase();
  const eventType = method.includes('todo') ? 'native.todo'
    : method.includes('plan') ? 'native.plan' : 'native.status';
  await request.callbacks.onEvent({
    eventId: crypto.createHash('sha256').update(JSON.stringify(notification)).digest('hex'),
    kind: 'domain', eventType, payload: notification,
  });
  const artifact = params.proprArtifact;
  if (artifact && typeof artifact === 'object') {
    await request.callbacks.onArtifact(artifact as Parameters<typeof request.callbacks.onArtifact>[0]);
  }
}

function resumeParams(threadId: string) {
  return {
    threadId, cwd: '/home/node/workspace', runtimeWorkspaceRoots: ['/home/node/workspace'],
    excludeTurns: true as const,
  };
}

function textInput(text: string) {
  return [{ type: 'text' as const, text, text_elements: [] as [] }];
}

function goalResult(goal: ThreadGoal | null): GoalRuntimeResult {
  if (!goal) return { outcome: 'failed', error: 'Codex native goal state disappeared', recoverable: false };
  if (goal.status === 'complete') return { outcome: 'completed' };
  if (goal.status === 'paused') return { outcome: 'paused' };
  return { outcome: 'interrupted', reason: `Codex native goal remains ${goal.status}` };
}
