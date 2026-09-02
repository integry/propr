import crypto from 'node:crypto';
import type { GoalState } from '@propr/shared';
import logger from '../../utils/logger.js';
import { GoalRepository } from './goalRepository.js';
import { deterministicGoalWorkspace } from './goalExecutionRepository.js';
import { GoalRuntimeControlRepository } from './goalRuntimeControlRepository.js';
import { GoalSupervisorRunner } from './goalSupervisorRunner.js';
import type { Goal } from './goalTypes.js';
import type {
  GoalArtifactVerifier,
  GoalProviderRuntime,
  GoalProviderRuntimeResolver,
} from './goalRuntimeTypes.js';

const RUNNABLE_STATES = new Set<GoalState>([
  'queued', 'planning', 'running', 'pausing', 'recovering', 'completing',
]);

export interface GoalSupervisorOptions {
  controllerId?: string;
  leaseTtlMs?: number;
  controlPollMs?: number;
  scanIntervalMs?: number;
  settlementTimeoutMs?: number;
  resolveBaseBranch?: (goal: Goal) => Promise<string> | string;
  allocateWorkspace?: (
    goal: Goal,
    workspace: ReturnType<typeof deterministicGoalWorkspace>
  ) => Promise<ReturnType<typeof deterministicGoalWorkspace>>;
  artifactVerifier?: GoalArtifactVerifier;
}

/** SQL-recoverable lifecycle owner for provider-native goals. */
export class GoalSupervisor {
  readonly controllerId: string;
  private readonly controls: GoalRuntimeControlRepository;
  private readonly runner: GoalSupervisorRunner;
  private readonly scanIntervalMs: number;
  private readonly active = new Map<string, { abort: AbortController; promise: Promise<void> }>();
  private scanTimer: NodeJS.Timeout | null = null;
  private stopped = true;

  constructor(
    private readonly repository: GoalRepository,
    runtimes: GoalProviderRuntimeResolver,
    options: GoalSupervisorOptions = {}
  ) {
    this.controllerId = options.controllerId ?? `goal-controller-${crypto.randomUUID()}`;
    const leaseTtlMs = options.leaseTtlMs ?? 30_000;
    const resolveBaseBranch = async (goal: Goal) => (
      await options.resolveBaseBranch?.(goal)
    ) ?? 'main';
    const allocateWorkspace = options.allocateWorkspace
      ?? (async (_goal: Goal, workspace: ReturnType<typeof deterministicGoalWorkspace>) => workspace);
    this.scanIntervalMs = options.scanIntervalMs ?? 5_000;
    this.controls = new GoalRuntimeControlRepository(repository.database);
    this.runner = new GoalSupervisorRunner({
      repository,
      runtimes,
      controllerId: this.controllerId,
      leaseTtlMs,
      controlPollMs: options.controlPollMs ?? Math.max(250, Math.floor(leaseTtlMs / 3)),
      settlementTimeoutMs: options.settlementTimeoutMs ?? 15_000,
      resolveBaseBranch,
      allocateWorkspace,
      artifactVerifier: options.artifactVerifier ?? missingArtifactVerifier(),
      isStopped: () => this.stopped,
    });
  }

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

  /** Best-effort latency hint; SQL scans remain authoritative. */
  wake(goalId: string): void {
    if (this.stopped || this.active.has(goalId)) return;
    this.launch(goalId);
  }

  async runOnce(goalId: string): Promise<void> {
    await this.runner.drive(goalId, new AbortController());
  }

  async scan(): Promise<void> {
    let cursor: string | null = null;
    do {
      const page = await this.repository.listGoals({
        visibility: 'all-demo', cursor, limit: 100,
      });
      for (const goal of page.goals) {
        if (RUNNABLE_STATES.has(goal.state)
            || await this.controls.hasPendingCancellation(goal.goalId)) {
          this.wake(goal.goalId);
        }
      }
      cursor = page.nextCursor;
    } while (cursor && !this.stopped);
  }

  private launch(goalId: string): void {
    const abort = new AbortController();
    const promise = this.runner.drive(goalId, abort)
      .catch(error => logger.error(
        { goalId, controllerId: this.controllerId, error: (error as Error).message },
        'Goal supervisor execution failed'
      ))
      .finally(() => {
        if (this.active.get(goalId)?.promise === promise) this.active.delete(goalId);
      });
    this.active.set(goalId, { abort, promise });
  }
}

export class GoalRuntimeMap implements GoalProviderRuntimeResolver {
  constructor(private readonly runtimes: ReadonlyMap<string, GoalProviderRuntime>) {}

  resolve(agentAlias: string): GoalProviderRuntime {
    const runtime = this.runtimes.get(agentAlias);
    if (!runtime) throw new Error(`No native goal runtime is registered for agent '${agentAlias}'`);
    return runtime;
  }
}

function missingArtifactVerifier(): GoalArtifactVerifier {
  return {
    verifyFinalPullRequest: async () => {
      throw new Error('A passive GitHub final pull request verifier is required');
    },
  };
}
