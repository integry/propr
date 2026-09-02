import type {
    GoalPendingCancellationContext, GoalProviderCancelRequest, GoalProviderOpenRequest,
    GoalProviderSessionSnapshot, GoalRepositoryIdentity,
} from './contract.js';
import { openSupervisedCodexAppServer, SUPERVISED_CODEX_MODEL } from './CodexAppServerOpen.js';
import type {
    GoalContainerSupervisor, GoalCredentialMount,
} from './GoalContainerSupervisor.js';
import { GoalSessionContractError } from './errors.js';
import type { GoalSupervisedOpenPlan } from './goalSessionOpen.js';
import { issueGoalSupervisedOpenPlan } from './goalSessionOpen.js';
import { createProviderProtocolDuplex } from './providerProtocolDuplex.js';

export interface SupervisedCodexAppServerFactoryOptions {
    repository: GoalRepositoryIdentity;
    worktreeFingerprint: string;
    image: string;
    command?: string[];
    credentialMounts?: ReadonlyArray<GoalCredentialMount>;
    environment?: Record<string, string>;
    maxProtocolQueueBytes?: number;
}

/** Injectable production composition for claimed container transport and App Server open. */
export interface GoalProviderOpenFactory {
    readonly plan: GoalSupervisedOpenPlan;
    open(request: GoalProviderOpenRequest): Promise<GoalProviderSessionSnapshot>;
    cancelPending(request: GoalProviderCancelRequest, pending: GoalPendingCancellationContext): Promise<void>;
}

export function createSupervisedCodexAppServerFactory(
    containers: GoalContainerSupervisor,
    options: SupervisedCodexAppServerFactoryOptions,
): GoalProviderOpenFactory {
    const credentialTargets = (options.credentialMounts ?? []).map(mount => mount.target);
    const fields: GoalSupervisedOpenPlan = {
        repository: options.repository,
        requestedModel: SUPERVISED_CODEX_MODEL,
        providerHomeTarget: '/home/node/.codex',
        credentialTargets,
    };
    const plan = issueGoalSupervisedOpenPlan(fields, {
        async createTransport(claim) {
            const duplex = createProviderProtocolDuplex(options.maxProtocolQueueBytes);
            let started: Awaited<ReturnType<GoalContainerSupervisor['startOpen']>>;
            try {
                started = await containers.startOpen({
                    goalId: claim.operationFence.goalId,
                sessionId: claim.operationFence.sessionId,
                controllerEpoch: claim.operationFence.controllerEpoch,
                executionId: claim.executionId,
                attemptId: claim.attemptId,
                deterministicOpenKey: claim.deterministicOpenKey,
                operationFence: claim.operationFence,
                image: options.image,
                command: options.command ?? ['codex', 'app-server'],
                worktreePath: options.repository.worktreePath,
                worktreeFingerprint: options.worktreeFingerprint,
                providerHomeTarget: '/home/node/.codex',
                environment: options.environment,
                credentialMounts: options.credentialMounts,
                    outputObserver: duplex.observer,
                });
            } catch (error) {
                await containers.cancelPendingOpen(claim).catch(() => undefined);
                throw error;
            }
            duplex.bindExecution(started.execution);
            return duplex.transport;
        },
        async cancelPending(claim) {
            await containers.cancelPendingOpen(claim);
        },
        transferPending(claim) {
            containers.transferPendingOpen(claim);
        },
    });
    return {
        plan,
        async open(request) {
            if (!request.openContext) throw new GoalSessionContractError(
                'Claimed Codex App Server context is missing', 'OPEN_CONTEXT_MISSING',
            );
            return openSupervisedCodexAppServer(request.openContext, request.persisted);
        },
        async cancelPending(request, pending) {
            await containers.cancelPendingOpenAttempt({
                goalId: request.goalId, sessionId: request.sessionId,
                attemptId: pending.initializationIntent.attemptId,
            });
        },
    };
}
