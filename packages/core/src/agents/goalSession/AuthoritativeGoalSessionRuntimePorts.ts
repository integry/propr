import type {
    GoalModelChangeHistoryPort, GoalProviderEffectStage, GoalProviderFirstEffectPort,
    GoalProviderOperationFence, GoalSessionEventSink, GoalSessionMessagePort,
    GoalSessionStatePort, GoalSessionTerminalPort, GoalSessionTransitionPort,
    GoalStartedProviderEffect,
} from './contract.js';
import type { GoalSessionRecoveryPort, GoalSessionRuntimePorts } from './runtimePorts.js';
import { GoalSessionContractError } from './errors.js';
import {
    assertStartedProviderEffect, cleanupStartedProviderEffect, startedProviderEffectCleanup,
} from './providerEffectProtocol.js';
import { assertGoalProviderEffectStage } from './providerOperationBoundary.js';

export type GoalProviderEffectClaimResult =
    | { status: 'claimed' | 'recoverable' }
    | { status: 'settled'; outcome: unknown }
    | { status: 'terminal_in_doubt' };

/**
 * Control-owned transaction hook. Implementations persist the stage claim before
 * `runClaimedProviderEffect`, then revalidate owner/state/fence inside the same
 * authoritative transaction that calls the synchronous callback and writes its
 * started receipt. A duplicate or abandoned claim is in doubt and is never run.
 */
export interface GoalProviderEffectTransactionDomain {
    claimProviderEffect(
        fence: GoalProviderOperationFence,
        stage: GoalProviderEffectStage,
    ): Promise<GoalProviderEffectClaimResult>;
    runClaimedProviderEffect<T>(
        fence: GoalProviderOperationFence,
        stage: GoalProviderEffectStage,
        effect: () => GoalStartedProviderEffect<T>,
    ): Promise<GoalStartedProviderEffect<T>>;
    settleProviderEffect(
        fence: GoalProviderOperationFence,
        stage: GoalProviderEffectStage,
        outcome: unknown,
    ): Promise<void>;
    markProviderEffectRecoverable(
        fence: GoalProviderOperationFence,
        stage: GoalProviderEffectStage,
    ): Promise<void>;
}

/** Ports supplied by the one authoritative migrated control repository. */
export interface GoalSessionAuthoritativeTransactionDomain {
    state: GoalSessionStatePort;
    transitions: GoalSessionTransitionPort;
    events: GoalSessionEventSink;
    terminal: GoalSessionTerminalPort;
    messages: GoalSessionMessagePort;
    modelChanges: GoalModelChangeHistoryPort;
    providerEffects: GoalProviderEffectTransactionDomain;
}

/**
 * Production composition adapter only: it owns no tables or SQLite connection.
 * Missing control-domain injection is a construction error; there is no memory
 * fallback. The injected domain is responsible for global session ownership.
 */
export class AuthoritativeGoalSessionRuntimePorts implements GoalProviderFirstEffectPort {
    constructor(
        private readonly domain: GoalSessionAuthoritativeTransactionDomain,
        private readonly recovery: GoalSessionRecoveryPort,
    ) {
        if (!domain?.state || !domain.transitions || !domain.events || !domain.terminal
            || !domain.messages || !domain.modelChanges || !domain.providerEffects
            || typeof domain.providerEffects.claimProviderEffect !== 'function'
            || typeof domain.providerEffects.runClaimedProviderEffect !== 'function'
            || typeof domain.providerEffects.settleProviderEffect !== 'function'
            || typeof domain.providerEffects.markProviderEffectRecoverable !== 'function'
            || typeof recovery?.inspectContainer !== 'function' || typeof recovery.inspectRepository !== 'function') {
            throw new GoalSessionContractError(
                'Goal runtime requires an authoritative transaction domain', 'AUTHORITATIVE_DOMAIN_MISSING',
            );
        }
    }

    asRuntimePorts(): GoalSessionRuntimePorts {
        return {
            state: this.domain.state,
            transitions: this.domain.transitions,
            events: this.domain.events,
            terminal: this.domain.terminal,
            messages: this.domain.messages,
            recovery: this.recovery,
            modelChanges: this.domain.modelChanges,
            providerFirstEffects: this,
        };
    }

    async start<T>(
        fence: GoalProviderOperationFence,
        stage: GoalProviderEffectStage,
        effect: () => GoalStartedProviderEffect<T>,
    ): Promise<T> {
        assertGoalProviderEffectStage(stage);
        const claim = await this.domain.providerEffects.claimProviderEffect(fence, stage);
        if (claim.status === 'settled') return claim.outcome as T;
        if (claim.status === 'terminal_in_doubt') throw new GoalSessionContractError(
            'Provider effect stage is already claimed and remains in doubt', 'PROVIDER_EFFECT_IN_DOUBT',
        );
        let started: GoalStartedProviderEffect<T> | undefined;
        let committed: GoalStartedProviderEffect<T>;
        let cleanup: GoalStartedProviderEffect<unknown>['cleanup'] | undefined;
        try {
            committed = await this.domain.providerEffects.runClaimedProviderEffect(fence, stage, () => {
                const candidate: unknown = effect();
                cleanup = startedProviderEffectCleanup(candidate);
                assertStartedProviderEffect<T>(candidate);
                started = candidate;
                return candidate;
            });
            assertStartedProviderEffect<T>(committed);
            if (committed !== started) throw new GoalSessionContractError(
                'Authoritative domain returned a different started-effect handle', 'INVALID_FIRST_EFFECT_HANDLE',
            );
        } catch (error) {
            if (started || cleanup) {
                try {
                    if (started) await cleanupStartedProviderEffect(started);
                    else await cleanup!.run();
                }
                catch {
                    throw new GoalSessionContractError(
                        'Started provider effect cleanup failed; durable stage remains in doubt',
                        'PROVIDER_EFFECT_CLEANUP_FAILED',
                    );
                }
            }
            throw error;
        }
        try {
            const outcome = await committed.completion;
            await this.domain.providerEffects.settleProviderEffect(fence, stage, outcome);
            return outcome;
        } catch (error) {
            await this.domain.providerEffects.markProviderEffectRecoverable(fence, stage).catch(() => undefined);
            throw error;
        }
    }
}
