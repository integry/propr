import { randomUUID } from 'node:crypto';
import type { Knex } from 'knex';
import type { SyntheticAgentConfig, SyntheticModelConfig, SyntheticModelMember } from '@propr/shared';
import { db } from '../db/connection.js';
import { getModelHardLimit } from '../config/modelLimits.js';
import { loadAgentTankSettings, loadSyntheticAgents } from '../config/configManager.js';
import { getStatus, type AgentStatusResponse } from './agentTankService.js';
import type { Agent, AgentExecutionResult, AgentTaskOptions, AnalysisResult, AnalyzeOptions } from '../agents/types.js';
import logger from '../utils/logger.js';
import { estimateTokens } from '../utils/tokenCalculation.js';
import { SyntheticPoolExhaustedError, isNonRetryableSyntheticFailure } from './syntheticRoutingTypes.js';
import type { BeginSyntheticRoutingOptions, SyntheticMemberDiagnostic, SyntheticPhysicalSelection, SyntheticRoutingServiceOptions, SyntheticUsageSnapshot, SyntheticUsageSnapshotProvider } from './syntheticRoutingTypes.js';

export * from './syntheticRoutingTypes.js';

const DEFAULT_OUTPUT_RESERVE_TOKENS = 16_000;
const DEFAULT_USAGE_FRESHNESS_MS = 5 * 60_000;

/**
 * Estimate every caller-provided field that can become part of an implementation
 * model's input. Keep this calculation call-scoped so an early selection and all
 * subsequent failover attempts use the same context constraint.
 */
export function estimateTaskRequiredTokens(options: AgentTaskOptions): number {
  const inputParts = [options.prompt];
  if (options.systemPrompt) inputParts.push(options.systemPrompt);
  if (options.retryReason) inputParts.push(options.retryReason);
  if (options.tools) inputParts.push(options.tools);

  // A missing custom prompt makes the physical adapters generate one from the
  // task metadata. Account for the token-bearing values used by that path.
  if (!options.prompt) {
    inputParts.push(
      options.issueRef.repoOwner,
      options.issueRef.repoName,
      String(options.issueRef.number),
      options.branchName || '',
      options.model || '',
      options.issueDetails ? JSON.stringify(options.issueDetails) || '' : '',
    );
  }

  return estimateTokens(inputParts.join('\n')) + DEFAULT_OUTPUT_RESERVE_TOKENS;
}

interface EligibleMember {
  member: SyntheticModelMember;
  agent: Agent;
  headroom: number;
}

function finitePercent(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
    ? value
    : undefined;
}

function nestedPercent(usage: Record<string, unknown>, names: string[]): number | undefined {
  for (const name of names) {
    const value = usage[name];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const percent = finitePercent((value as Record<string, unknown>).percent)
        ?? finitePercent((value as Record<string, unknown>).percentUsed);
      if (percent !== undefined) return percent;
    }
  }
  return undefined;
}

/**
 * Agent Tank is accepted only when the returned record names the exact direct
 * alias requested. A provider-level `claude` record therefore cannot be copied
 * to `claude-work` and `claude-personal`.
 */
export class AliasSpecificAgentTankSnapshotProvider implements SyntheticUsageSnapshotProvider {
  constructor(
    private readonly now: () => Date = () => new Date(),
    private readonly freshnessMs = Number(process.env.SYNTHETIC_USAGE_FRESHNESS_MS) || DEFAULT_USAGE_FRESHNESS_MS,
    private readonly fetchStatus: (alias: string) => Promise<AgentStatusResponse> = getStatus,
  ) {}

  async getSnapshot(directAgentAlias: string): Promise<SyntheticUsageSnapshot | null> {
    const settings = await loadAgentTankSettings();
    if (!settings.enabled) return null;

    let status: AgentStatusResponse;
    try {
      status = await this.fetchStatus(directAgentAlias);
    } catch (error) {
      logger.warn({ directAgentAlias, error: (error as Error).message }, 'Alias-specific usage snapshot unavailable');
      return null;
    }

    if (status.name !== directAgentAlias || status.error || status.isRefreshing || !status.lastUpdated) return null;
    const capturedAt = new Date(status.lastUpdated);
    if (!Number.isFinite(capturedAt.getTime()) || this.now().getTime() - capturedAt.getTime() > this.freshnessMs) return null;

    return {
      directAgentAlias,
      capturedAt,
      sessionPercent: nestedPercent(status.usage, ['session']),
      weeklyPercent: nestedPercent(status.usage, ['weekly', 'weeklyAll', 'week']),
    };
  }
}

function resultFailure(result: AnalysisResult | AgentExecutionResult): Error {
  const error = new Error(result.error || 'Physical agent execution failed');
  const resultError = result as typeof result & { errorName?: string; errorCode?: string };
  if (resultError.errorName) error.name = resultError.errorName;
  if (resultError.errorCode) (error as Error & { code?: string }).code = resultError.errorCode;
  return error;
}

export class SyntheticRoutingSession {
  private current?: SyntheticPhysicalSelection;
  private lastFailedSelection?: SyntheticPhysicalSelection;
  private readonly attemptedMemberIds = new Set<string>();
  private readonly attemptFailures = new Map<string, string>();
  private executionAttemptCount = 0;
  private readonly physicalAgentEligibility?: (agent: Agent) => boolean;

  public readonly requestedAgentAlias: string;
  public readonly requestedModel: string;
  public readonly callId: string;
  private _requiredTokens: number;

  constructor(
    private readonly service: SyntheticRoutingService,
    options: Required<Pick<BeginSyntheticRoutingOptions, 'requestedAgentAlias' | 'requestedModel' | 'requiredTokens' | 'callId'>>
      & Pick<BeginSyntheticRoutingOptions, 'physicalAgentEligibility'>,
  ) {
    this.requestedAgentAlias = options.requestedAgentAlias;
    this.requestedModel = options.requestedModel;
    this._requiredTokens = options.requiredTokens;
    this.callId = options.callId;
    this.physicalAgentEligibility = options.physicalAgentEligibility;
  }

  get requiredTokens(): number {
    return this._requiredTokens;
  }

  get attemptedMembers(): ReadonlySet<string> {
    return this.attemptedMemberIds;
  }

  /** Metadata for the current, or most recently failed, physical member of a synthetic call. */
  get routingMetadata(): Record<string, unknown> | undefined { const selection = this.current?.synthetic ? this.current : this.lastFailedSelection; return selection ? this.service.metadataFor(selection) : undefined; }

  isPhysicalAgentEligible(agent: Agent): boolean { return this.physicalAgentEligibility?.(agent) ?? true; }

  async select(): Promise<SyntheticPhysicalSelection> {
    if (this.current) return this.current;
    this.current = await this.service.select(this);
    if (this.current.memberId) this.attemptedMemberIds.add(this.current.memberId);
    return this.current;
  }

  private failCurrent(reason: string): void {
    if (this.current?.memberId) this.attemptFailures.set(this.current.memberId, reason);
    if (this.current?.synthetic) this.lastFailedSelection = this.current;
    this.current = undefined;
  }

  failureReason(memberId: string): string | undefined {
    return this.attemptFailures.get(memberId);
  }

  /** Start a distinct logical call with the same virtual request and constraint. */
  fork(): SyntheticRoutingSession {
    return this.service.begin({
      requestedAgentAlias: this.requestedAgentAlias,
      requestedModel: this.requestedModel,
      requiredTokens: this.requiredTokens,
      physicalAgentEligibility: this.physicalAgentEligibility,
    });
  }

  /**
   * Finalize the prompt requirement after early model selection but before the
   * first physical invocation. Retries then reuse this exact constraint.
   */
  constrain(requiredTokens: number): void {
    if (this.executionAttemptCount > 0) return;
    this._requiredTokens = Math.max(this._requiredTokens, requiredTokens);
    if (!this.current?.memberId) return;
    const hardLimit = getModelHardLimit(`${this.current.physicalAgentAlias}:${this.current.physicalModel}`);
    if (hardLimit >= this._requiredTokens) return;
    // The member was pinned, not attempted. Let normal selection reconsider it
    // with the now-known prompt requirement and do not report it as failed.
    this.attemptedMemberIds.delete(this.current.memberId);
    this.current = undefined;
  }

  async analyze(prompt: string, options: AnalyzeOptions = {}): Promise<AnalysisResult> {
    this.constrain(estimateTokens(`${prompt}${options.context || ''}`) + DEFAULT_OUTPUT_RESERVE_TOKENS);
    for (;;) {
      const selection = await this.select();
      this.executionAttemptCount += 1;
      await this.service.recordAttempt(selection, options.taskId);
      const routingMetadata = this.service.metadataFor(selection);
      try {
        const result = await selection.physicalAgent.analyze(prompt, {
          ...options,
          model: selection.physicalModel,
          metadata: selection.synthetic
            ? { ...options.metadata, syntheticRouting: routingMetadata }
            : options.metadata,
        });
        if (result.success) return result;
        const failure = resultFailure(result);
        if (isNonRetryableSyntheticFailure(result) || !selection.synthetic) return result;
        this.failCurrent(failure.message);
      } catch (error) {
        if (isNonRetryableSyntheticFailure(error) || !selection.synthetic) throw error;
        this.failCurrent((error as Error).message);
      }
    }
  }

  async executeTask(options: AgentTaskOptions): Promise<AgentExecutionResult> {
    this.constrain(estimateTaskRequiredTokens(options));
    for (;;) {
      const selection = await this.select();
      this.executionAttemptCount += 1;
      const attemptHistoryId = await this.service.recordAttempt(selection, options.taskId);
      try {
        const result = await selection.physicalAgent.executeTask({
          ...options,
          model: selection.physicalModel,
          isRetry: selection.attemptNumber > 1 || options.isRetry,
          retryReason: selection.attemptNumber > 1
            ? this.failureReason([...this.attemptedMemberIds][this.attemptedMemberIds.size - 2] || '') || options.retryReason
            : options.retryReason,
          metadata: selection.synthetic
            ? { ...options.metadata, syntheticRouting: this.service.metadataFor(selection) }
            : options.metadata,
          onContainerId: async (containerId, containerName) => {
            await this.service.recordAttemptContainer(attemptHistoryId, selection, containerId, containerName);
            await options.onContainerId?.(containerId, containerName);
          },
        });
        if (result.success) return result;
        const failure = resultFailure(result);
        if (isNonRetryableSyntheticFailure(result) || !selection.synthetic) return result;
        this.failCurrent(failure.message);
      } catch (error) {
        if (isNonRetryableSyntheticFailure(error) || !selection.synthetic) throw error;
        this.failCurrent((error as Error).message);
      }
    }
  }
}

export class SyntheticRoutingService {
  private readonly database: Knex;
  private readonly loadConfigs: () => Promise<SyntheticAgentConfig[]>;
  private readonly getDirectAgent: (alias: string) => Agent | undefined;
  private readonly usageProvider: SyntheticUsageSnapshotProvider;

  constructor(options: SyntheticRoutingServiceOptions) {
    this.database = options.database ?? db;
    this.loadConfigs = options.loadSyntheticConfigs ?? loadSyntheticAgents;
    this.getDirectAgent = options.getDirectAgent;
    this.usageProvider = options.usageSnapshotProvider ?? new AliasSpecificAgentTankSnapshotProvider(options.now);
  }

  begin(options: BeginSyntheticRoutingOptions): SyntheticRoutingSession {
    const requiredTokens = options.requiredTokens
      ?? Math.max(0, options.promptTokens ?? 0) + (options.outputReserveTokens ?? DEFAULT_OUTPUT_RESERVE_TOKENS);
    return new SyntheticRoutingSession(this, {
      requestedAgentAlias: options.requestedAgentAlias,
      requestedModel: options.requestedModel || '',
      requiredTokens,
      callId: options.callId || randomUUID(),
      physicalAgentEligibility: options.physicalAgentEligibility,
    });
  }

  private async loadSyntheticModel(alias: string, requestedModel: string, callId: string): Promise<{
    agent: SyntheticAgentConfig;
    model: SyntheticModelConfig;
  } | null> {
    const agent = (await this.loadConfigs()).find(item => item.alias === alias);
    if (!agent) return null;
    const modelId = requestedModel || agent.defaultModel;
    const model = agent.models.find(item => item.id === modelId);
    if (!model) {
      throw new SyntheticPoolExhaustedError(alias, modelId, callId, [{
        memberId: '', directAgentAlias: alias, model: modelId, eligible: false, reason: 'virtual model is not configured',
      }]);
    }
    return { agent, model };
  }

  private async inspectMember(
    member: SyntheticModelMember,
    session: SyntheticRoutingSession,
  ): Promise<{ diagnostic: SyntheticMemberDiagnostic; eligible?: EligibleMember }> {
    const reject = (reason: string) => ({
      diagnostic: { memberId: member.id, directAgentAlias: member.directAgentAlias, model: member.model, eligible: false, reason },
    });
    if (!member.enabled) return reject('disabled');
    if (session.attemptedMembers.has(member.id)) return reject(session.failureReason(member.id) ? `attempt failed: ${session.failureReason(member.id)}` : 'already attempted');
    const agent = this.getDirectAgent(member.directAgentAlias);
    if (!agent || !agent.config.enabled) return reject('direct agent unavailable or disabled');
    if (!session.isPhysicalAgentEligible(agent)) return reject('physical agent is ineligible for this routing session');
    if (!agent.config.supportedModels.includes(member.model)) return reject('model is not supported by the direct agent');
    const hardLimit = getModelHardLimit(`${member.directAgentAlias}:${member.model}`);
    if (session.requiredTokens > hardLimit) return reject(`context window ${hardLimit} is below required ${session.requiredTokens} tokens`);

    let headroom = 1;
    if (member.usageLimits) {
      const snapshot = await this.usageProvider.getSnapshot(member.directAgentAlias);
      if (!snapshot) return reject('fresh alias-specific usage data unavailable');
      const headrooms: number[] = [];
      if (member.usageLimits.sessionMaxPercent !== undefined) {
        if (snapshot.sessionPercent === undefined) return reject('session usage is unavailable');
        if (snapshot.sessionPercent >= member.usageLimits.sessionMaxPercent) return reject('session usage cap reached');
        headrooms.push((member.usageLimits.sessionMaxPercent - snapshot.sessionPercent) / member.usageLimits.sessionMaxPercent);
      }
      if (member.usageLimits.weeklyMaxPercent !== undefined) {
        if (snapshot.weeklyPercent === undefined) return reject('weekly usage is unavailable');
        if (snapshot.weeklyPercent >= member.usageLimits.weeklyMaxPercent) return reject('weekly usage cap reached');
        headrooms.push((member.usageLimits.weeklyMaxPercent - snapshot.weeklyPercent) / member.usageLimits.weeklyMaxPercent);
      }
      headroom = headrooms.length ? Math.min(...headrooms) : 1;
    }

    return {
      diagnostic: { memberId: member.id, directAgentAlias: member.directAgentAlias, model: member.model, eligible: true, reason: 'eligible' },
      eligible: { member, agent, headroom },
    };
  }

  private async nextCursor(key: string): Promise<number> {
    return this.database.transaction(async trx => {
      await trx('synthetic_routing_cursors').insert({ synthetic_model_key: key, cursor: 0 })
        .onConflict('synthetic_model_key').ignore();
      const row = await trx('synthetic_routing_cursors').where({ synthetic_model_key: key }).first<{ cursor: number | string }>();
      const cursor = Number(row?.cursor ?? 0);
      await trx('synthetic_routing_cursors').where({ synthetic_model_key: key }).update({ cursor: cursor + 1, updated_at: trx.fn.now() });
      return cursor;
    });
  }

  async select(session: SyntheticRoutingSession): Promise<SyntheticPhysicalSelection> {
    const synthetic = await this.loadSyntheticModel(session.requestedAgentAlias, session.requestedModel, session.callId);
    if (!synthetic) {
      const agent = this.getDirectAgent(session.requestedAgentAlias);
      if (!agent) throw new Error(`Agent not found: ${session.requestedAgentAlias}`);
      if (!session.isPhysicalAgentEligible(agent)) {
        throw new Error(`Physical agent '${session.requestedAgentAlias}' is ineligible for this routing session`);
      }
      const physicalModel = session.requestedModel || agent.config.defaultModel;
      if (!physicalModel) throw new Error(`No model configured for direct agent '${session.requestedAgentAlias}'`);
      return {
        virtualAgentAlias: session.requestedAgentAlias, virtualModel: physicalModel,
        physicalAgent: agent, physicalAgentAlias: agent.config.alias, physicalModel,
        callId: session.callId, attemptNumber: 1, selectionReason: 'direct agent request',
        requiredTokens: session.requiredTokens, diagnostics: [], synthetic: false,
      };
    }

    if (!synthetic.agent.enabled || !synthetic.model.enabled) {
      throw new SyntheticPoolExhaustedError(synthetic.agent.alias, synthetic.model.id, session.callId, [{
        memberId: '', directAgentAlias: synthetic.agent.alias, model: synthetic.model.id,
        eligible: false, reason: !synthetic.agent.enabled ? 'synthetic agent disabled' : 'synthetic model disabled',
      }]);
    }

    const inspected = await Promise.all(synthetic.model.members.map(member => this.inspectMember(member, session)));
    const diagnostics = inspected.map(item => item.diagnostic);
    const eligible = inspected.flatMap(item => item.eligible ? [item.eligible] : []);
    if (eligible.length === 0) {
      throw new SyntheticPoolExhaustedError(synthetic.agent.alias, synthetic.model.id, session.callId, diagnostics);
    }

    const highestPriority = Math.max(...eligible.map(item => item.member.priority));
    const tier = eligible.filter(item => item.member.priority === highestPriority);
    let chosen: EligibleMember;
    let selectionReason: string;
    if (synthetic.model.strategy === 'usage_based') {
      chosen = [...tier].sort((a, b) => b.headroom - a.headroom || a.member.id.localeCompare(b.member.id))[0];
      selectionReason = `usage_based: priority ${highestPriority}, normalized headroom ${chosen.headroom.toFixed(4)}`;
    } else {
      const cursor = await this.nextCursor(`${synthetic.agent.id}:${synthetic.model.id}`);
      chosen = tier[cursor % tier.length];
      selectionReason = `round_robin: priority ${highestPriority}, cursor ${cursor}`;
    }

    return {
      virtualAgentAlias: synthetic.agent.alias,
      virtualModel: synthetic.model.id,
      physicalAgent: chosen.agent,
      physicalAgentAlias: chosen.member.directAgentAlias,
      physicalModel: chosen.member.model,
      memberId: chosen.member.id,
      callId: session.callId,
      attemptNumber: session.attemptedMembers.size + 1,
      selectionReason,
      requiredTokens: session.requiredTokens,
      diagnostics,
      synthetic: true,
    };
  }

  /**
   * Probe pool availability without consuming the persisted round-robin cursor.
   * Members are checked in priority order so health probes reflect the same
   * failover tiers as workload routing, while remaining side-effect free.
   */
  async healthCheck(session: SyntheticRoutingSession): Promise<boolean> {
    const synthetic = await this.loadSyntheticModel(session.requestedAgentAlias, session.requestedModel, session.callId);
    if (!synthetic) {
      const agent = this.getDirectAgent(session.requestedAgentAlias);
      if (!agent?.config.enabled || !session.isPhysicalAgentEligible(agent)) return false;
      try {
        return await agent.healthCheck();
      } catch {
        return false;
      }
    }

    if (!synthetic.agent.enabled || !synthetic.model.enabled) return false;

    const inspected = await Promise.all(synthetic.model.members.map(member => this.inspectMember(member, session)));
    const eligible = inspected.flatMap(item => item.eligible ? [item.eligible] : []);
    const candidates = [...eligible].sort((a, b) => {
      const priority = b.member.priority - a.member.priority;
      if (priority !== 0) return priority;
      if (synthetic.model.strategy === 'usage_based') {
        const headroom = b.headroom - a.headroom;
        if (headroom !== 0) return headroom;
      }
      return a.member.id.localeCompare(b.member.id);
    });

    for (const candidate of candidates) {
      try {
        if (await candidate.agent.healthCheck()) return true;
      } catch {
        // A failed probe makes only this member unavailable; keep checking the
        // remaining members and lower-priority failover tiers.
      }
    }
    return false;
  }

  metadataFor(selection: SyntheticPhysicalSelection): Record<string, unknown> {
    return {
      virtualAgentAlias: selection.virtualAgentAlias,
      virtualModel: selection.virtualModel,
      physicalAgentAlias: selection.physicalAgentAlias,
      physicalModel: selection.physicalModel,
      memberId: selection.memberId,
      callId: selection.callId,
      attemptNumber: selection.attemptNumber,
      selectionReason: selection.selectionReason,
      requiredTokens: selection.requiredTokens,
    };
  }

  async recordAttempt(selection: SyntheticPhysicalSelection, taskId?: string): Promise<number | null> {
    if (!selection.synthetic || !taskId) return null;
    try {
      const task = await this.database('tasks').where({ task_id: taskId }).first('task_id');
      if (!task) return null;
      const [inserted] = await this.database('task_history').insert({
        task_id: taskId,
        state: 'claude_execution',
        timestamp: new Date().toISOString(),
        reason: `Synthetic routing attempt ${selection.attemptNumber}`,
        metadata: JSON.stringify({ syntheticRouting: this.metadataFor(selection) }),
      }).returning('history_id');
      return typeof inserted === 'object'
        ? Number((inserted as { history_id: number }).history_id)
        : Number(inserted);
    } catch (error) {
      logger.warn({ taskId, callId: selection.callId, error: (error as Error).message }, 'Could not persist synthetic routing attempt history');
      return null;
    }
  }

  async recordAttemptContainer(
    historyId: number | null,
    selection: SyntheticPhysicalSelection,
    containerId: string,
    containerName: string,
  ): Promise<void> {
    if (!historyId || !selection.synthetic) return;
    try {
      await this.database('task_history').where({ history_id: historyId }).update({
        metadata: JSON.stringify({
          syntheticRouting: this.metadataFor(selection),
          containerId,
          containerName,
        }),
      });
    } catch (error) {
      logger.warn({ historyId, callId: selection.callId, error: (error as Error).message }, 'Could not attach container identity to synthetic routing attempt');
    }
  }
}
