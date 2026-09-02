import crypto from 'node:crypto';
import type { AgentConfig } from '../../agents/types.js';
import { toAntigravityCliModelId } from '../../agents/impl/antigravityModelIds.js';
import type {
  GoalProviderRuntime,
  GoalRuntimeAuthority,
  GoalRuntimeEvent,
  GoalRuntimeExecution,
  GoalRuntimeRequest,
  GoalRuntimeResult,
  GoalSteeringRequest,
} from './goalRuntimeTypes.js';
import { GoalDockerContainerManager } from './goalDockerContainer.js';

type CliProvider = 'claude' | 'antigravity';

export class CliGoalProviderRuntime implements GoalProviderRuntime {
  private readonly active = new Map<string, Promise<GoalRuntimeResult>>();

  constructor(
    private readonly provider: CliProvider,
    private readonly config: AgentConfig,
    private readonly containers: GoalDockerContainerManager,
    private readonly resolveGithubToken: () => Promise<string>
  ) {}

  start(request: GoalRuntimeRequest): Promise<GoalRuntimeResult> {
    return this.run(request, false);
  }

  resume(request: GoalRuntimeRequest): Promise<GoalRuntimeResult> {
    return this.run(request, true);
  }

  async steer(request: GoalSteeringRequest): Promise<{ acknowledged: boolean }> {
    await request.authority.assertCurrent();
    const result = await this.executeTurn({
      execution: request.execution, prompt: request.body, resume: true,
    });
    return { acknowledged: result.outcome.outcome === 'completed' };
  }

  async pause(execution: GoalRuntimeExecution, authority: GoalRuntimeAuthority): Promise<void> {
    await authority.assertCurrent();
    if (execution.runtimeId) await this.containers.signal(execution.runtimeId, 'INT');
  }

  async cancel(execution: GoalRuntimeExecution, authority: GoalRuntimeAuthority): Promise<void> {
    await authority.assertCurrent();
    if (execution.runtimeId) await this.containers.signal(execution.runtimeId, 'TERM');
  }

  async changeModel(
    execution: GoalRuntimeExecution,
    model: string,
    authority: GoalRuntimeAuthority
  ): Promise<{ effectiveModel: string }> {
    await authority.assertCurrent();
    const result = await this.executeTurn({
      execution,
      prompt: 'Apply this model change at the current native-goal safe boundary, then report status.',
      resume: true,
      model,
    });
    if (result.outcome.outcome !== 'completed') throw new Error('Provider did not acknowledge model change');
    return { effectiveModel: model };
  }

  async settle(execution: GoalRuntimeExecution, authority: GoalRuntimeAuthority): Promise<void> {
    await authority.assertCurrent();
    await this.active.get(execution.executionId);
  }

  async terminate(execution: GoalRuntimeExecution, authority: GoalRuntimeAuthority): Promise<void> {
    await authority.assertCurrent();
    if (execution.runtimeId) await this.containers.terminate(execution.runtimeId);
  }

  private run(request: GoalRuntimeRequest, resume: boolean): Promise<GoalRuntimeResult> {
    const running = this.runOwned(request, resume);
    this.active.set(request.execution.executionId, running);
    void running.finally(() => {
      if (this.active.get(request.execution.executionId) === running) {
        this.active.delete(request.execution.executionId);
      }
    });
    return running;
  }

  private async runOwned(request: GoalRuntimeRequest, resume: boolean): Promise<GoalRuntimeResult> {
    await request.authority.assertCurrent();
    const container = await this.containers.ensure(
      request.execution,
      this.config,
      await this.resolveGithubToken()
    );
    const sessionId = deterministicSessionId(this.provider, request.execution.executionId);
    // Container creation is deliberately provider-first. If this callback crashes,
    // retry adopts the label-fenced container and the same deterministic session.
    await request.callbacks.onSessionIdentity({
      providerSessionId: sessionId,
      providerThreadId: sessionId,
      runtimeId: container.id,
      worktreeId: request.execution.workspace.worktreeId,
    });
    const result = await this.executeTurn({
      execution: {
        ...request.execution,
        runtimeId: container.id,
        providerSessionId: sessionId,
        providerThreadId: sessionId,
      },
      prompt: resume
        ? 'Continue the persisted native goal from its last provider checkpoint.'
        : request.command,
      resume,
      model: request.execution.effectiveModel,
      signal: request.signal,
    });
    if (result.events) {
      for (const event of result.events) await request.callbacks.onEvent(event);
    }
    if (result.artifacts) {
      for (const artifact of result.artifacts) await request.callbacks.onArtifact(artifact);
    }
    return result.outcome;
  }

  private async executeTurn(input: {
    execution: GoalRuntimeExecution;
    prompt: string;
    resume: boolean;
    model?: string;
    signal?: AbortSignal;
  }): Promise<ParsedCliResult> {
    const { execution, prompt, resume, model, signal } = input;
    if (!execution.runtimeId) throw new Error('Goal runtime container identity is missing');
    const sessionId = execution.providerSessionId
      ?? deterministicSessionId(this.provider, execution.executionId);
    const args = this.provider === 'claude'
      ? claudeArgs(sessionId, resume, model)
      : antigravityArgs(sessionId, resume, model);
    const result = await this.containers.executeInContainer(execution.runtimeId, args, {
      stdinData: prompt,
      signal,
      timeout: 24 * 60 * 60 * 1000,
    });
    return parseCliResult(result.stdout, result.stderr, result.exitCode);
  }
}

interface ParsedCliResult {
  outcome: GoalRuntimeResult;
  events?: GoalRuntimeEvent[];
  artifacts?: Array<Parameters<GoalRuntimeRequest['callbacks']['onArtifact']>[0]>;
}

function claudeArgs(sessionId: string, resume: boolean, model?: string): string[] {
  return [
    'claude', '-p', '-', '--output-format', 'stream-json', '--verbose',
    '--dangerously-skip-permissions',
    ...(resume ? ['--resume', sessionId] : ['--session-id', sessionId]),
    ...(model ? ['--model', cleanModel(model)] : []),
  ];
}

function antigravityArgs(sessionId: string, resume: boolean, model?: string): string[] {
  return [
    'agy', '--dangerously-skip-permissions',
    ...(resume ? ['--resume', sessionId] : ['--session-id', sessionId]),
    ...(model ? ['--model', toAntigravityCliModelId(model)] : []),
  ];
}

function parseCliResult(stdout: string, stderr: string, exitCode: number | null): ParsedCliResult {
  const events: GoalRuntimeEvent[] = [];
  const artifacts: NonNullable<ParsedCliResult['artifacts']> = [];
  let sequence = 0;
  for (const line of stdout.split('\n').map(value => value.trim()).filter(Boolean)) {
    let value: Record<string, unknown>;
    try { value = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    sequence += 1;
    const text = JSON.stringify(value).toLowerCase();
    const eventType = text.includes('todo') ? 'native.todo'
      : text.includes('plan') ? 'native.plan'
        : 'native.status';
    events.push({
      eventId: crypto.createHash('sha256').update(line).digest('hex'),
      kind: 'domain', eventType, payload: value, nativeSequence: sequence,
    });
    if (value.proprArtifact && typeof value.proprArtifact === 'object') {
      artifacts.push(value.proprArtifact as NonNullable<ParsedCliResult['artifacts']>[number]);
    }
  }
  return {
    outcome: exitCode === 0
      ? { outcome: 'completed' }
      : { outcome: 'interrupted', reason: stderr.slice(0, 1000) || 'provider process exited' },
    events,
    artifacts,
  };
}

function deterministicSessionId(provider: string, executionId: string): string {
  const hash = crypto.createHash('sha256').update(`${provider}\0${executionId}`).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

function cleanModel(model: string): string {
  return model.includes(':') ? model.split(':').at(-1)! : model;
}
