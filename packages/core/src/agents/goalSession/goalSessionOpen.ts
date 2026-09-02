import type {
    GoalProviderDuplexTransport, GoalProviderOpenContext, GoalProviderOperationFence,
    GoalRepositoryIdentity, GoalSessionAdapter, GoalSessionIdentity, GoalSessionState,
} from './contract.js';
import { GoalSessionContractError } from './errors.js';
import { credentialFreeRepositoryIdentity } from './repositorySecurity.js';
import { assertSafeProviderIdentifier } from './securityBoundary.js';
import { SUPERVISED_CODEX_MODEL } from './CodexAppServerOpen.js';

export interface OpenGoalSessionRequest extends GoalSessionIdentity {
    provider: string;
    controllerEpoch: number;
    supervisedOpen?: GoalSupervisedOpenPlan;
}

export interface GoalSupervisedOpenClaim {
    executionId: string;
    attemptId: string;
    deterministicOpenKey: string;
    operationGeneration: number;
    operationFence: GoalProviderOperationFence;
}

export interface GoalSupervisedOpenPlan {
    readonly repository: GoalRepositoryIdentity;
    readonly requestedModel: string;
    readonly providerHomeTarget: string;
    readonly credentialTargets: readonly string[];
}

interface GoalSupervisedOpenPlanInternals {
    createTransport(claim: Readonly<GoalSupervisedOpenClaim>): Promise<GoalProviderDuplexTransport>;
    cancelPending(claim: Readonly<GoalSupervisedOpenClaim>): Promise<void>;
    transferPending(claim: Readonly<GoalSupervisedOpenClaim>): void;
}

const SUPERVISED_OPEN_PLANS = new WeakMap<object, GoalSupervisedOpenPlanInternals>();

/** Issues the only runtime-valid supervised-open plan. */
export function issueGoalSupervisedOpenPlan(
    fields: GoalSupervisedOpenPlan,
    internals: GoalSupervisedOpenPlanInternals,
): GoalSupervisedOpenPlan {
    const plan = Object.freeze(Object.assign(Object.create(null), {
        repository: Object.freeze({ ...fields.repository }),
        requestedModel: fields.requestedModel,
        providerHomeTarget: fields.providerHomeTarget,
        credentialTargets: Object.freeze([...fields.credentialTargets]),
    })) as GoalSupervisedOpenPlan;
    SUPERVISED_OPEN_PLANS.set(plan, internals);
    return plan;
}

export function supervisedOpenPlanInternals(plan: GoalSupervisedOpenPlan): GoalSupervisedOpenPlanInternals {
    const internals = SUPERVISED_OPEN_PLANS.get(plan);
    if (!internals) throw new GoalSessionContractError(
        'Supervised open plan was not issued by the production factory', 'UNSAFE_PROVIDER_VALUE',
    );
    return internals;
}

export interface GoalOwnedOpenContext {
    context: GoalProviderOpenContext;
    cancel(): Promise<void>;
    transfer(): void;
}

export async function createClaimedOpenContext(options: {
    adapter: Pick<GoalSessionAdapter, 'provider' | 'capabilities'>;
    plan: GoalSupervisedOpenPlan;
    claim: GoalSupervisedOpenClaim;
    requireCurrent(): Promise<GoalSessionState>;
}): Promise<GoalOwnedOpenContext> {
    const exactClaim = Object.freeze({ ...options.claim });
    const internals = supervisedOpenPlanInternals(options.plan);
    const transport = await internals.createTransport(exactClaim);
    try {
        const current = await options.requireCurrent();
        if (current.providerOpenAttemptId !== exactClaim.attemptId) {
            throw new GoalSessionContractError('Supervised provider transport was cancelled after spawn', 'STALE_FENCE');
        }
        const context = await validateClaimedEagerOpenContext(options.adapter, {
            ...exactClaim, repository: options.plan.repository,
            requestedModel: options.plan.requestedModel, providerHomeTarget: options.plan.providerHomeTarget,
            credentialTargets: [...options.plan.credentialTargets], transport,
        });
        return {
            context, cancel: () => internals.cancelPending(exactClaim),
            transfer: () => internals.transferPending(exactClaim),
        };
    } catch (error) {
        await internals.cancelPending(exactClaim).catch(() => undefined);
        throw error;
    }
}

export function createOptionalClaimedOpenContext(options: {
    adapter: Pick<GoalSessionAdapter, 'provider' | 'capabilities'>;
    plan?: GoalSupervisedOpenPlan;
    executionId: string; attemptId: string; openKey?: string; operationGeneration: number;
    operationFence: GoalProviderOperationFence;
    requireCurrent(): Promise<GoalSessionState>;
}): Promise<GoalOwnedOpenContext | undefined> {
    if (!options.plan) return Promise.resolve(undefined);
    if (!options.openKey) throw new GoalSessionContractError(
        'Supervised open claim is missing its durable identity', 'OPEN_ATTEMPT_MISSING',
    );
    return createClaimedOpenContext({
        adapter: options.adapter, plan: options.plan,
        claim: {
            executionId: options.executionId, attemptId: options.attemptId,
            deterministicOpenKey: options.openKey, operationGeneration: options.operationGeneration,
            operationFence: options.operationFence,
        },
        requireCurrent: options.requireCurrent,
    });
}

export async function validateClaimedEagerOpenContext(
    adapter: Pick<GoalSessionAdapter, 'provider' | 'capabilities'>,
    context: GoalProviderOpenContext,
): Promise<GoalProviderOpenContext> {
    if (adapter.provider !== 'codex' || adapter.capabilities.nativeSessionId !== 'eager') {
        throw new GoalSessionContractError(
            'Only eager Codex open accepts a claimed supervised context', 'UNSAFE_PROVIDER_VALUE',
        );
    }
    assertSafeProviderIdentifier(context.executionId);
    assertSafeProviderIdentifier(context.attemptId);
    if (context.requestedModel !== SUPERVISED_CODEX_MODEL) throw new GoalSessionContractError(
        'Eager Codex open requires exact gpt-5.6-sol', 'MODEL_ACK_MISMATCH',
    );
    validateCredentialTargets(context.credentialTargets, 'Codex credential targets are unsafe');
    const repository = await credentialFreeRepositoryIdentity(context.repository);
    if (!isExactRepositoryIdentity(repository, context.repository)
        || context.providerHomeTarget !== '/home/node/.codex'
        || typeof context.transport.write !== 'function'
        || typeof context.transport.closeInput !== 'function'
        || typeof context.transport.cancel !== 'function'
        || !context.transport.output || typeof context.transport.output[Symbol.asyncIterator] !== 'function'
        || !context.transport.completion || typeof context.transport.completion.then !== 'function') {
        throw new GoalSessionContractError('Eager Codex open context is unsafe', 'UNSAFE_PROVIDER_VALUE');
    }
    return {
        executionId: context.executionId, attemptId: context.attemptId,
        repository, requestedModel: context.requestedModel,
        providerHomeTarget: context.providerHomeTarget,
        credentialTargets: [...context.credentialTargets],
        deterministicOpenKey: context.deterministicOpenKey,
        transport: context.transport,
    };
}

export async function validateSupervisedOpenPlan(
    adapter: Pick<GoalSessionAdapter, 'provider' | 'capabilities'>,
    plan: GoalSupervisedOpenPlan,
): Promise<void> {
    supervisedOpenPlanInternals(plan);
    if (adapter.provider !== 'codex' || adapter.capabilities.nativeSessionId !== 'eager') {
        throw new GoalSessionContractError('Supervised eager open is Codex-only', 'UNSAFE_PROVIDER_VALUE');
    }
    if (plan.requestedModel !== SUPERVISED_CODEX_MODEL || plan.providerHomeTarget !== '/home/node/.codex'
        || !Object.isFrozen(plan) || Object.getPrototypeOf(plan) !== null) throw new GoalSessionContractError(
        'Supervised Codex open plan is not canonical', 'UNSAFE_PROVIDER_VALUE',
    );
    const repository = await credentialFreeRepositoryIdentity(plan.repository);
    validateCredentialTargets(plan.credentialTargets, 'Supervised Codex open plan is unsafe');
    if (!isExactRepositoryIdentity(repository, plan.repository)) {
        throw new GoalSessionContractError('Supervised Codex open plan is unsafe', 'UNSAFE_PROVIDER_VALUE');
    }
}

function validateCredentialTargets(value: unknown, message: string): asserts value is string[] {
    if (!Array.isArray(value) || value.length > 16
        || value.some(target => typeof target !== 'string'
            || !target.startsWith('/home/node/.codex/') || target.includes('\0'))
        || new Set(value).size !== value.length) {
        throw new GoalSessionContractError(message, 'UNSAFE_PROVIDER_VALUE');
    }
}

export function durableCodexOpenKey(state: GoalSessionState): string | undefined {
    const metadata = state.recoveryMetadata;
    if (!metadata || Array.isArray(metadata) || typeof metadata !== 'object') return undefined;
    const payload = metadata.payload;
    if (!payload || Array.isArray(payload) || typeof payload !== 'object') return undefined;
    return typeof payload.openKey === 'string' ? payload.openKey : undefined;
}

function isExactRepositoryIdentity(canonical: GoalRepositoryIdentity, candidate: GoalRepositoryIdentity): boolean {
    const keys = Object.keys(candidate);
    return keys.every(key => ['repository', 'worktreePath', 'branch', 'headSha'].includes(key))
        && canonical.repository === candidate.repository
        && canonical.worktreePath === candidate.worktreePath
        && canonical.branch === candidate.branch
        && canonical.headSha === candidate.headSha;
}
