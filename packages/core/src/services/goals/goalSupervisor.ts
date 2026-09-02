/* eslint-disable max-lines -- native session lifecycle and lease-fenced control must remain coordinated */
import crypto from 'crypto';
import {
  GOAL_ERROR_CODES,
  isTerminalGoalState,
  type GoalState,
} from '@propr/shared';
import logger from '../../utils/logger.js';
import { GoalRepository, GoalError } from './goalRepository.js';
import type { Goal, GoalLeaseFence, GoalMessage } from './goalTypes.js';
import {
  GoalExecutionRepository,
  buildNativeGoalCommand,
  buildNativeGoalPolicy,
  deterministicGoalWorkspace,
} from './goalExecutionRepository.js';
import type {
  GoalProviderRuntime,
  GoalProviderRuntimeResolver,
  GoalReportedArtifact,
  GoalRuntimeCallbacks,
  GoalRuntimeEvent,
  GoalRuntimeExecution,
  GoalRuntimeAuthority,
  GoalRuntimeResult,
} from './goalRuntimeTypes.js';

const RUNNABLE_STATES = new Set<GoalState>([
  'queued', 'planning', 'running', 'pausing', 'recovering', 'completing',
]);

export interface GoalSupervisorOptions {
  controllerId?: string;
  leaseTtlMs?: number;
  controlPollMs?: number;
  scanIntervalMs?: number;
  /** Resolves the repository base once; the result is snapshotted per execution. */
  resolveBaseBranch?: (goal: Goal) => Promise<string> | string;
}

/**
 * Durable, provider-agnostic supervisor for native goal sessions.
 *
 * Queues and Redis may call wake(), but every decision is reconstructed from
 * SQL.  A live lease fence is rechecked by every authoritative repository
 * mutation, so a replaced controller cannot dispatch messages or persist
 * provider/GitHub observations after takeover.
 */
export class GoalSupervisor {
  readonly controllerId: string;
  private readonly executions: GoalExecutionRepository;
  private readonly leaseTtlMs: number;
  private readonly controlPollMs: number;
  private readonly scanIntervalMs: number;
  private readonly resolveBaseBranch: (goal: Goal) => Promise<string>;
  private readonly active = new Map<string, { abort: AbortController; promise: Promise<void> }>();
  private scanTimer: NodeJS.Timeout | null = null;
  private stopped = true;

  constructor(
    private readonly repository: GoalRepository,
    private readonly runtimes: GoalProviderRuntimeResolver,
    options: GoalSupervisorOptions = {}
  ) {
    this.controllerId = options.controllerId ?? `goal-controller-${crypto.randomUUID()}`;
    this.executions = new GoalExecutionRepository(repository.database);
    this.leaseTtlMs = options.leaseTtlMs ?? 30_000;
    this.controlPollMs = options.controlPollMs ?? Math.max(250, Math.floor(this.leaseTtlMs / 3));
    this.scanIntervalMs = options.scanIntervalMs ?? 5_000;
    this.resolveBaseBranch = async (goal) => (await options.resolveBaseBranch?.(goal)) ?? 'main';
  }

  /** Runs the mandatory startup scan and keeps scanning SQL for recovery work. */
  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    await this.scan();
    this.scanTimer = setInterval(() => {
      void this.scan().catch(error => logger.error(
        { error: (error as Error).message, controllerId: this.controllerId },
        'Goal supervisor scan failed'
      ));
    }, this.scanIntervalMs);
    this.scanTimer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.scanTimer) clearInterval(this.scanTimer);
    this.scanTimer = null;
    const running = [...this.active.values()];
    for (const item of running) item.abort.abort(new Error('Goal supervisor stopped'));
    await Promise.allSettled(running.map(item => item.promise));
  }

  /** A best-effort latency hint. SQL remains the source of truth. */
  wake(goalId: string): void {
    if (this.stopped || this.active.has(goalId)) return;
    this.launch(goalId);
  }

  /** Public deterministic entry point used by startup and adversarial tests. */
  async runOnce(goalId: string): Promise<void> {
    const localAbort = new AbortController();
    await this.drive(goalId, localAbort);
  }

  async scan(): Promise<void> {
    let cursor: string | null = null;
    do {
      const page = await this.repository.listGoals({
        visibility: 'all-demo',
        cursor,
        limit: 100,
      });
      for (const goal of page.goals) {
        if (RUNNABLE_STATES.has(goal.state)) this.wake(goal.goalId);
      }
      cursor = page.nextCursor;
    } while (cursor && !this.stopped);
  }

  private launch(goalId: string): void {
    const abort = new AbortController();
    const promise = this.drive(goalId, abort)
      .catch(error => logger.error(
        { goalId, controllerId: this.controllerId, error: (error as Error).message },
        'Goal supervisor execution failed'
      ))
      .finally(() => {
        if (this.active.get(goalId)?.promise === promise) this.active.delete(goalId);
      });
    this.active.set(goalId, { abort, promise });
  }

  private async drive(goalId: string, abort: AbortController): Promise<void> {
    let fence: GoalLeaseFence | null = null;
    let execution: GoalRuntimeExecution | null = null;
    let runtime: GoalProviderRuntime | null = null;
    try {
      const lease = await this.repository.claimLease(goalId, this.controllerId, this.leaseTtlMs);
      fence = { leaseOwner: this.controllerId, leaseEpoch: lease.epoch };
      let goal = await this.repository.requireGoal(goalId);
      runtime = await this.runtimes.resolve(goal.agent);

      goal = await this.enterControllerState(goal, fence);
      const workspace = deterministicGoalWorkspace(goal, await this.resolveBaseBranch(goal));
      execution = await this.executions.allocate(goal, {
        workspace,
        policy: buildNativeGoalPolicy(goal),
      }, fence);

      // Upgrade sessions created by the initial control-plane migration. This
      // preserves their exact provider identity rather than starting over.
      if (!execution.providerThreadId) {
        const legacy = await this.repository.getProviderSession(goalId, goal.agent);
        if (legacy?.provider_thread_id) {
          execution = await this.persistIdentity(goal, execution, {
            providerSessionId: legacy.session_id,
            providerThreadId: legacy.provider_thread_id,
            runtimeId: legacy.runtime_id,
            worktreeId: legacy.worktree_id ?? execution.workspace.worktreeId,
          }, fence);
        }
      }

      if (goal.state === 'pausing') {
        await this.pauseAtBoundary(goal, execution, runtime, fence);
        return;
      }

      execution = await this.executions.updateState(
        goalId,
        execution.executionId,
        execution.providerThreadId ? 'interrupted' : 'starting',
        fence
      );

      const callbacks = this.callbacks(goal, execution, fence, value => { execution = value; });
      if (execution.providerThreadId && (goal.state === 'planning' || goal.state === 'recovering')) {
        goal = await this.repository.transition(goalId, {
          toState: 'running',
          leaseOwner: fence.leaseOwner,
          leaseEpoch: fence.leaseEpoch,
          reason: 'provider_session_resumed',
          idempotencyKey: durableKey('running', execution.executionId, fence.leaseEpoch),
        });
      }

      const request = {
        goal,
        execution,
        command: buildNativeGoalCommand(goal.objective, execution.policy),
        authority: this.authority(goalId, fence),
        callbacks,
        signal: abort.signal,
      };
      await request.authority.assertCurrent();
      const runtimePromise = (execution.providerThreadId
        ? runtime.resume(request)
        : runtime.start(request)).then(result => ({ source: 'runtime' as const, result }));
      const controls = this.controlLoop(goalId, execution, runtime, fence, abort);
      const winner = await Promise.race([
        runtimePromise,
        controls.then(outcome => ({ source: 'control' as const, outcome })),
      ]);
      abort.abort();
      if (winner.source === 'control') return;
      await Promise.allSettled([controls]);
      const result = winner.result;
      execution = await this.executions.get(goalId) ?? execution;
      if (!execution.providerSessionId || !execution.providerThreadId) {
        throw new Error('Provider finished before persisting a recoverable session identity');
      }
      await this.finish(goalId, execution, result, runtime, fence);
    } catch (error) {
      abort.abort(error);
      if (!isExpectedOwnershipEnd(error)) {
        await this.recordInterruption(goalId, execution, fence, error);
        throw error;
      }
    } finally {
      if (fence) {
        try {
          await this.repository.releaseLease(goalId, fence.leaseOwner, fence.leaseEpoch);
        } catch (error) {
          if (!isExpectedOwnershipEnd(error)) logger.warn(
            { goalId, error: (error as Error).message },
            'Failed to release goal controller lease'
          );
        }
      }
    }
  }

  private callbacks(
    goal: Goal,
    initialExecution: GoalRuntimeExecution,
    fence: GoalLeaseFence,
    setExecution: (execution: GoalRuntimeExecution) => void
  ): GoalRuntimeCallbacks {
    return {
      onSessionIdentity: async identity => {
        const updated = await this.persistIdentity(goal, initialExecution, identity, fence);
        setExecution(updated);
        const current = await this.repository.requireGoal(goal.goalId);
        if (current.state === 'planning' || current.state === 'recovering') {
          await this.repository.transition(goal.goalId, {
            toState: 'running',
            leaseOwner: fence.leaseOwner,
            leaseEpoch: fence.leaseEpoch,
            reason: 'provider_session_identity_persisted',
            idempotencyKey: durableKey('running', initialExecution.executionId, fence.leaseEpoch),
          });
        }
      },
      onEvent: event => this.recordNativeEvent(goal.goalId, initialExecution.executionId, event, fence),
      onArtifact: artifact => this.recordArtifact(goal.goalId, initialExecution.executionId, artifact, fence),
    };
  }

  private async persistIdentity(
    goal: Goal,
    execution: GoalRuntimeExecution,
    identity: Parameters<GoalRuntimeCallbacks['onSessionIdentity']>[0],
    fence: GoalLeaseFence
  ): Promise<GoalRuntimeExecution> {
    // Both records are fenced. The execution record is written first and is the
    // authoritative recovery identity; the legacy row remains a compatibility
    // read model for the existing goal API/repository contract.
    const updated = await this.executions.persistSessionIdentity(
      goal.goalId,
      execution.executionId,
      identity,
      fence
    );
    await this.repository.upsertProviderSession(goal.goalId, goal.agent, {
      ...fence,
      providerThreadId: identity.providerThreadId,
      runtimeId: identity.runtimeId,
      worktreeId: identity.worktreeId,
      effectiveModel: updated.effectiveModel,
      recoveryMetadata: { schemaVersion: 1, providerState: 'active' },
    });
    await this.repository.appendEvent(goal.goalId, {
      ...fence,
      kind: 'lifecycle',
      eventType: 'provider.session.persisted',
      payload: {
        executionId: execution.executionId,
        providerSessionId: identity.providerSessionId,
        providerThreadId: identity.providerThreadId,
        worktreeId: identity.worktreeId,
      },
      idempotencyKey: durableKey('session', execution.executionId, identity.providerSessionId),
    });
    return updated;
  }

  private async recordNativeEvent(
    goalId: string,
    executionId: string,
    event: GoalRuntimeEvent,
    fence: GoalLeaseFence
  ): Promise<void> {
    const execution = await this.executions.get(goalId);
    if (!execution?.providerThreadId) {
      throw new GoalError(
        GOAL_ERROR_CODES.recoveryMetadataInvalid,
        'Native events cannot precede durable provider session identity',
        409
      );
    }
    await this.repository.appendEvent(goalId, {
      ...fence,
      kind: event.kind,
      eventType: event.eventType,
      ...(event.payload === undefined ? {} : { payload: event.payload }),
      idempotencyKey: durableKey('native-event', executionId, event.eventId),
    });
    if (event.checkpoint !== undefined || event.nativeSequence !== undefined) {
      const current = await this.executions.get(goalId);
      if (current) {
        await this.executions.updateState(goalId, executionId, current.state, fence, {
          checkpoint: event.checkpoint,
          nativeSequence: event.nativeSequence,
        });
        if (event.checkpoint !== undefined) {
          const goal = await this.repository.requireGoal(goalId);
          await this.repository.upsertProviderSession(goalId, goal.agent, {
            ...fence,
            lastCheckpoint: event.checkpoint,
            recoveryMetadata: {
              schemaVersion: 1,
              providerState: 'active',
              lastEventSequence: event.nativeSequence,
            },
          });
        }
      }
    }
  }

  private async recordArtifact(
    goalId: string,
    executionId: string,
    artifact: GoalReportedArtifact,
    fence: GoalLeaseFence
  ): Promise<void> {
    const execution = await this.executions.get(goalId);
    if (!execution?.providerThreadId) {
      throw new GoalError(
        GOAL_ERROR_CODES.recoveryMetadataInvalid,
        'Reported artifacts cannot precede durable provider session identity',
        409
      );
    }
    await this.executions.recordArtifact(goalId, executionId, artifact, fence);
    await this.repository.appendEvent(goalId, {
      ...fence,
      kind: 'domain',
      eventType: artifact.finalEpicPullRequest ? 'native.final_epic_pr' : 'native.artifact',
      payload: artifact,
      idempotencyKey: durableKey(
        'artifact',
        executionId,
        artifact.artifactKey,
        JSON.stringify({ state: artifact.state, draft: artifact.draft, headSha: artifact.headSha })
      ),
    });
  }

  // eslint-disable-next-line max-params -- the execution, runtime, lease fence, and abort controller form the live control boundary
  private async controlLoop(
    goalId: string,
    initialExecution: GoalRuntimeExecution,
    runtime: GoalProviderRuntime,
    fence: GoalLeaseFence,
    abort: AbortController
  ): Promise<'paused' | 'cancelled' | null> {
    let execution = initialExecution;
    while (!abort.signal.aborted) {
      try {
        await abortableDelay(this.controlPollMs, abort.signal);
        if (abort.signal.aborted) return null;
        const goal = await this.repository.requireGoal(goalId);
        if (goal.state === 'cancelled') {
          execution = await this.executions.get(goalId) ?? execution;
          const authority = this.authority(goalId, fence, true);
          await authority.assertCurrent();
          await runtime.cancel(execution, authority);
          return 'cancelled';
        }
        await this.repository.renewLease(goalId, fence.leaseOwner, fence.leaseEpoch, this.leaseTtlMs);
        execution = await this.executions.heartbeat(goalId, execution.executionId, fence);
        if (goal.state === 'pausing') {
          await this.pauseAtBoundary(goal, execution, runtime, fence);
          return 'paused';
        }
        if (goal.requestedModel !== goal.effectiveModel) {
          if (!execution.providerThreadId) continue;
          const authority = this.authority(goalId, fence);
          await authority.assertCurrent();
          const changed = await runtime.changeModel(execution, goal.requestedModel, authority);
          if (changed.effectiveModel !== goal.requestedModel) {
            throw new Error('Provider did not apply the requested model at its safe boundary');
          }
          await this.repository.applyModelChange(goalId, fence);
          execution = await this.executions.updateState(goalId, execution.executionId, execution.state, fence, {
            effectiveModel: changed.effectiveModel,
          });
        }
        if (execution.providerThreadId) {
          await this.deliverMessages(goalId, execution, runtime, fence);
        }
      } catch (error) {
        if (abort.signal.aborted) return null;
        abort.abort(error);
        throw error;
      }
    }
    return null;
  }

  private async deliverMessages(
    goalId: string,
    execution: GoalRuntimeExecution,
    runtime: GoalProviderRuntime,
    fence: GoalLeaseFence
  ): Promise<void> {
    const messages = await this.repository.getMessages(goalId);
    for (const message of messages) {
      if (message.state === 'acknowledged') continue;
      await this.deliverMessage(goalId, execution, runtime, fence, message);
      // A provider may accept but not acknowledge a message until a later safe
      // boundary. Stop here to preserve strict FIFO.
      const current = (await this.repository.getMessages(goalId)).find(item => item.messageId === message.messageId);
      if (current?.state !== 'acknowledged') break;
    }
  }

  // eslint-disable-next-line max-params -- message delivery must carry the exact execution and lease fence together
  private async deliverMessage(
    goalId: string,
    execution: GoalRuntimeExecution,
    runtime: GoalProviderRuntime,
    fence: GoalLeaseFence,
    message: GoalMessage
  ): Promise<void> {
    // providerMessageId is the durable idempotency key. Resending a delivered
    // but unacknowledged message after a crash must not create a second turn.
    const authority = this.authority(goalId, fence);
    await authority.assertCurrent();
    const result = await runtime.steer({
      execution,
      providerMessageId: message.messageId,
      body: message.body,
      predefinedKind: message.predefinedKind,
      authority,
    });
    if (message.state === 'queued') {
      await this.repository.markMessageDelivered(goalId, message.messageId, fence);
    }
    if (result.acknowledged) {
      await this.repository.markMessageAcknowledged(goalId, message.messageId, fence);
    }
  }

  private async pauseAtBoundary(
    goal: Goal,
    execution: GoalRuntimeExecution,
    runtime: GoalProviderRuntime,
    fence: GoalLeaseFence
  ): Promise<void> {
    await this.executions.updateState(goal.goalId, execution.executionId, 'pausing', fence);
    if (execution.providerThreadId) {
      const authority = this.authority(goal.goalId, fence);
      await authority.assertCurrent();
      await runtime.pause(execution, authority);
    }
    await this.executions.updateState(goal.goalId, execution.executionId, 'paused', fence);
    const current = await this.repository.requireGoal(goal.goalId);
    if (current.state === 'pausing') {
      await this.repository.transition(goal.goalId, {
        toState: 'paused',
        leaseOwner: fence.leaseOwner,
        leaseEpoch: fence.leaseEpoch,
        reason: 'provider_safe_boundary_paused',
        idempotencyKey: durableKey('paused', execution.executionId, fence.leaseEpoch),
      });
    }
  }

  // eslint-disable-next-line max-params -- completion reconciles the exact execution result under its runtime and lease fence
  private async finish(
    goalId: string,
    execution: GoalRuntimeExecution,
    result: GoalRuntimeResult,
    runtime: GoalProviderRuntime,
    fence: GoalLeaseFence
  ): Promise<void> {
    if (result.outcome === 'paused') {
      await this.pauseAtBoundary(await this.repository.requireGoal(goalId), execution, runtime, fence);
      return;
    }
    if (result.outcome === 'cancelled') return;
    if (result.outcome === 'interrupted' || (result.outcome === 'failed' && result.recoverable)) {
      const reason = result.outcome === 'interrupted' ? result.reason : result.error;
      const checkpoint = result.outcome === 'interrupted' ? result.checkpoint : undefined;
      await this.executions.updateState(goalId, execution.executionId, 'interrupted', fence, { checkpoint });
      await this.markRecovering(goalId, execution, fence, reason ?? 'provider_interrupted');
      return;
    }
    if (result.outcome === 'failed') {
      await this.executions.updateState(goalId, execution.executionId, 'failed', fence);
      await this.failGoal(goalId, execution, fence, result.error);
      return;
    }

    if (result.finalArtifact) await this.recordArtifact(goalId, execution.executionId, result.finalArtifact, fence);
    const goal = await this.repository.requireGoal(goalId);
    if (goal.mergePolicy === 'manual' && result.finalArtifact
      && (result.finalArtifact.draft !== true || result.merged === true || result.finalArtifact.state === 'merged')) {
      await this.executions.updateState(goalId, execution.executionId, 'failed', fence);
      await this.failGoal(goalId, execution, fence, 'Final epic PR must remain draft and unmerged for human approval');
      return;
    }
    await this.executions.updateState(goalId, execution.executionId, 'completing', fence);
    let current = await this.repository.requireGoal(goalId);
    if (current.state !== 'completing') {
      current = await this.repository.transition(goalId, {
        toState: 'completing',
        leaseOwner: fence.leaseOwner,
        leaseEpoch: fence.leaseEpoch,
        reason: 'native_goal_completed',
        idempotencyKey: durableKey('completing', execution.executionId),
      });
    }
    if (current.mergePolicy !== 'manual' && result.merged !== true) return;
    await this.executions.updateState(goalId, execution.executionId, 'completed', fence);
    await this.repository.transition(goalId, {
      toState: 'completed',
      leaseOwner: fence.leaseOwner,
      leaseEpoch: fence.leaseEpoch,
      terminalReason: 'objective_met',
      reason: current.mergePolicy === 'manual' ? 'final_epic_pr_ready_for_human' : 'final_epic_pr_merged',
      idempotencyKey: durableKey('completed', execution.executionId),
    });
  }

  private async enterControllerState(goal: Goal, fence: GoalLeaseFence): Promise<Goal> {
    if (goal.state === 'queued') {
      return this.repository.transition(goal.goalId, {
        toState: 'planning',
        ...fence,
        reason: 'native_goal_launch',
        idempotencyKey: durableKey('launch', goal.goalId),
      });
    }
    if (goal.state === 'running') {
      return this.repository.transition(goal.goalId, {
        toState: 'recovering',
        ...fence,
        reason: 'controller_startup_recovery',
        idempotencyKey: durableKey('recovering', goal.goalId, fence.leaseEpoch),
      });
    }
    return goal;
  }

  private async markRecovering(
    goalId: string,
    execution: GoalRuntimeExecution,
    fence: GoalLeaseFence,
    reason: string
  ): Promise<void> {
    await this.repository.upsertProviderSession(goalId, execution.agent, {
      ...fence,
      lastCheckpoint: execution.lastCheckpoint,
      recoveryMetadata: {
        schemaVersion: 1,
        providerState: execution.providerThreadId ? 'recoverable' : 'interrupted',
        reason: reason.slice(0, 256),
      },
    });
    const goal = await this.repository.requireGoal(goalId);
    if (goal.state === 'running') {
      await this.repository.transition(goalId, {
        toState: 'recovering',
        ...fence,
        reason: reason.slice(0, 1000),
        idempotencyKey: durableKey('interrupted', execution.executionId, fence.leaseEpoch),
      });
    }
  }

  private async failGoal(
    goalId: string,
    execution: GoalRuntimeExecution,
    fence: GoalLeaseFence,
    error: string
  ): Promise<void> {
    const goal = await this.repository.requireGoal(goalId);
    if (isTerminalGoalState(goal.state)) return;
    await this.repository.appendEvent(goalId, {
      ...fence,
      kind: 'lifecycle',
      eventType: 'provider.failed',
      payload: { error },
      idempotencyKey: durableKey('failed-event', execution.executionId),
    });
    await this.repository.transition(goalId, {
      toState: 'failed',
      ...fence,
      terminalReason: 'unrecoverable_error',
      reason: error.slice(0, 1000),
      idempotencyKey: durableKey('terminal-failed', execution.executionId),
    });
  }

  private async recordInterruption(
    goalId: string,
    execution: GoalRuntimeExecution | null,
    fence: GoalLeaseFence | null,
    error: unknown
  ): Promise<void> {
    if (!execution || !fence) return;
    try {
      const goal = await this.repository.requireGoal(goalId);
      if (isTerminalGoalState(goal.state)) return;
      await this.executions.updateState(goalId, execution.executionId, 'interrupted', fence);
      await this.markRecovering(goalId, execution, fence, (error as Error).message || 'controller_interrupted');
    } catch (recordError) {
      if (!isExpectedOwnershipEnd(recordError)) logger.warn(
        { goalId, error: (recordError as Error).message },
        'Failed to persist goal interruption'
      );
    }
  }

  private authority(
    goalId: string,
    fence: GoalLeaseFence,
    allowTerminal = false
  ): GoalRuntimeAuthority {
    return {
      controllerId: fence.leaseOwner,
      leaseGeneration: fence.leaseEpoch,
      assertCurrent: () => this.repository.assertLease(
        goalId,
        fence.leaseOwner,
        fence.leaseEpoch,
        { allowTerminal }
      ),
    };
  }
}

/** Simple resolver for production composition and tests. */
export class GoalRuntimeMap implements GoalProviderRuntimeResolver {
  constructor(private readonly runtimes: ReadonlyMap<string, GoalProviderRuntime>) {}

  resolve(agentAlias: string): GoalProviderRuntime {
    const runtime = this.runtimes.get(agentAlias);
    if (!runtime) throw new Error(`No native goal runtime is registered for agent '${agentAlias}'`);
    return runtime;
  }
}

function isExpectedOwnershipEnd(error: unknown): boolean {
  const codes: readonly string[] = [
    GOAL_ERROR_CODES.leaseConflict,
    GOAL_ERROR_CODES.staleLease,
    GOAL_ERROR_CODES.terminalState,
  ];
  return error instanceof GoalError && codes.includes(error.code);
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(done, ms);
    timer.unref?.();
    function done() {
      signal.removeEventListener('abort', done);
      clearTimeout(timer);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

function durableKey(scope: string, ...values: Array<string | number | undefined>): string {
  const hash = crypto.createHash('sha256');
  for (const value of values) hash.update(String(value)).update('\0');
  return `${scope}:${hash.digest('hex')}`;
}
