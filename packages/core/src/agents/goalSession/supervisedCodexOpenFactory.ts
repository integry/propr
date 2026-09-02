import type {
    GoalProviderOpenRequest, GoalProviderSessionSnapshot, GoalRepositoryIdentity,
} from './contract.js';
import { openSupervisedCodexAppServer, SUPERVISED_CODEX_MODEL } from './CodexAppServerOpen.js';
import type {
    GoalContainerSupervisor, GoalCredentialMount,
} from './GoalContainerSupervisor.js';
import { GoalSessionContractError } from './errors.js';
import type { GoalSupervisedOpenPlan } from './goalSessionOpen.js';
import { createProviderProtocolDuplex } from './providerProtocolDuplex.js';
import { startedProviderEffect } from './providerEffectProtocol.js';

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
}

export function createSupervisedCodexAppServerFactory(
    containers: GoalContainerSupervisor,
    options: SupervisedCodexAppServerFactoryOptions,
): GoalProviderOpenFactory {
    const credentialTargets = (options.credentialMounts ?? []).map(mount => mount.target);
    const plan: GoalSupervisedOpenPlan = {
        repository: options.repository,
        requestedModel: SUPERVISED_CODEX_MODEL,
        providerHomeTarget: '/home/node/.codex',
        credentialTargets,
        createTransport(claim) {
            const duplex = createProviderProtocolDuplex(options.maxProtocolQueueBytes);
            const completion = containers.startOpen({
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
            }).then(started => {
                duplex.bindExecution(started.execution);
                return duplex.transport;
            });
            return startedProviderEffect(completion);
        },
    };
    return {
        plan,
        async open(request) {
            if (!request.openContext) throw new GoalSessionContractError(
                'Claimed Codex App Server context is missing', 'OPEN_CONTEXT_MISSING',
            );
            return openSupervisedCodexAppServer(request.openContext, request.persisted);
        },
    };
}
