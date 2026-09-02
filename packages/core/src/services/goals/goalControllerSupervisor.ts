import { GOAL_ERROR_CODES } from '@propr/shared';
import { GoalError } from './goalRepositorySupport.js';
import { GoalRepository } from './goalRepository.js';
import { GoalOrchestrationRepository } from './goalOrchestrationRepository.js';
import type { GoalLeaseFence } from './goalTypes.js';

export interface GoalSupervisorOptions {
  controllerId: string;
  leaseTtlMs?: number;
  pollIntervalMs?: number;
}

/** Startup scans are deterministic and SQL-backed; queue wakeups are optional. */
export class GoalControllerSupervisor {
  private readonly owned = new Map<string, GoalLeaseFence>();
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  constructor(
    private readonly goals: GoalRepository,
    private readonly orchestration: GoalOrchestrationRepository,
    private readonly options: GoalSupervisorOptions
  ) {}

  async recover(handler: (goalId: string, fence: GoalLeaseFence) => Promise<void>): Promise<{ claimed: string[]; skipped: string[] }> {
    const candidates = await this.orchestration.listRecoverableGoals();
    const claimed: string[] = [];
    const skipped: string[] = [];
    for (const goalId of candidates) {
      try {
        const lease = await this.goals.claimLease(goalId, this.options.controllerId, this.options.leaseTtlMs ?? 60_000);
        const fence = { leaseOwner: this.options.controllerId, leaseEpoch: lease.epoch };
        await this.orchestration.heartbeat(goalId, this.options.controllerId, { phase: 'startup_recovery' }, fence);
        await handler(goalId, fence);
        this.owned.set(goalId, fence);
        claimed.push(goalId);
      } catch (error) {
        if (error instanceof GoalError
          && (error.code === GOAL_ERROR_CODES.leaseConflict || error.code === GOAL_ERROR_CODES.terminalState)) {
          skipped.push(goalId);
          continue;
        }
        throw error;
      }
    }
    return { claimed, skipped };
  }

  async renew(goalId: string, fence: GoalLeaseFence): Promise<GoalLeaseFence> {
    await this.goals.renewLease(goalId, fence.leaseOwner, fence.leaseEpoch, this.options.leaseTtlMs ?? 60_000);
    await this.orchestration.heartbeat(goalId, this.options.controllerId, { phase: 'active' }, fence);
    return fence;
  }

  async tickOwned(handler: (goalId: string, fence: GoalLeaseFence) => Promise<void>): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const previouslyOwned = new Set(this.owned.keys());
      await this.recover(handler);
      for (const [goalId, fence] of this.owned) {
        if (!previouslyOwned.has(goalId)) continue;
        try {
          await this.renew(goalId, fence);
          await handler(goalId, fence);
        } catch (error) {
          if (error instanceof GoalError
            && (error.code === GOAL_ERROR_CODES.staleLease || error.code === GOAL_ERROR_CODES.terminalState)) {
            this.owned.delete(goalId);
            continue;
          }
          throw error;
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  async start(handler: (goalId: string, fence: GoalLeaseFence) => Promise<void>): Promise<void> {
    if (this.timer) return;
    await this.tickOwned(handler);
    this.timer = setInterval(() => { void this.tickOwned(handler); }, this.options.pollIntervalMs ?? 5_000);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const releases = [...this.owned].map(async ([goalId, fence]) => {
      try { await this.goals.releaseLease(goalId, fence.leaseOwner, fence.leaseEpoch); } catch { /* takeover/terminal */ }
    });
    this.owned.clear();
    await Promise.all(releases);
  }
}
