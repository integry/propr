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
    repository: GoalRepositoryIdentity;
    requestedModel: string;
    providerHomeTarget: string;
    credentialTargets: string[];
    createTransport(claim: Readonly<GoalSupervisedOpenClaim>): Promise<GoalProviderDuplexTransport>;
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
    if (adapter.provider !== 'codex' || adapter.capabilities.nativeSessionId !== 'eager') {
        throw new GoalSessionContractError('Supervised eager open is Codex-only', 'UNSAFE_PROVIDER_VALUE');
    }
    if (plan.requestedModel !== SUPERVISED_CODEX_MODEL || plan.providerHomeTarget !== '/home/node/.codex'
        || typeof plan.createTransport !== 'function') throw new GoalSessionContractError(
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
