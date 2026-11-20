import type { AgentRegistryOperationalStatus } from './agentRegistryTypes.js';
import type { Agent, AgentConfig } from './types.js';
import { AGENT_DEFAULT_VERSIONS } from './version/types.js';
import { remainingUnifiedAgentImageCircuitCooldown } from './unifiedAgentImageRecovery.js';
import type { AgentType } from './types.js';

/**
 * Where a configured agent CLI version stands against the image runs use.
 *
 * A CLI version change only takes effect once the worker has prepared the new
 * agent image. Until then runs keep using the previously prepared image (and
 * its CLI version); they never wait and never mix versions within one image.
 */
export type AgentCliVersionStatus = 'ready' | 'preparing' | 'failed';

export interface AgentCliVersionState {
    agentId: string;
    alias: string;
    type: string;
    /** The CLI version the saved configuration asks for. */
    configuredVersion: string | null;
    /** The CLI version runs use right now, or null when no image is in use yet. */
    effectiveVersion: string | null;
    status: AgentCliVersionStatus;
    /** Why preparation failed, when it did. */
    error?: string;
    /**
     * When the next automatic preparation attempt is due after a failure:
     * the backoff retry, or the end of a recovery circuit's cooldown.
     */
    nextRetryAt?: string;
    /**
     * Whether a failed preparation recovers without an operator: backoff
     * retries and circuits opened by transient failures do; disk pressure
     * does not. Only set on failed states.
     */
    automaticRetry?: boolean;
}

type RegistryView = {
    getAgentByAlias(alias: string): Agent | undefined;
    getOperationalStatus(): AgentRegistryOperationalStatus;
};

/** Matches the expected, transient state while the worker is still building an image. */
export function isAwaitingWorkerImagePreparation(error: string | undefined): boolean {
    return !!error && /has not been prepared by the worker/.test(error);
}

function configuredCliVersion(config: Pick<AgentConfig, 'type' | 'cliVersionResolved'>): string | null {
    return config.cliVersionResolved || AGENT_DEFAULT_VERSIONS[config.type as AgentType] || null;
}

function preparationFailed(status: AgentRegistryOperationalStatus['unifiedAgentImage']): boolean {
    if (status.status !== 'unavailable') return false;
    return !!status.operatorActionRequired || !!status.circuitBreakerOpen || (status.retryCount ?? 0) > 0;
}

type UnifiedImageStatus = AgentRegistryOperationalStatus['unifiedAgentImage'];

/** The next automatic attempt; an open transient circuit half-opens once its cooldown ends. */
function nextAutomaticRetryAt(status: UnifiedImageStatus, now = Date.now()): string | undefined {
    if (status.operatorActionRequired) return undefined;
    if (!status.circuitBreakerOpen) return status.nextRetryAt;
    if (!status.circuitOpenedAt) return undefined;
    const remaining = remainingUnifiedAgentImageCircuitCooldown({ ...status, error: status.error ?? '', recordedAt: status.recordedAt ?? '' }, now);
    return new Date(now + remaining).toISOString();
}

/**
 * Compares each enabled agent's configured CLI version with the version of the
 * agent the live registry runs. Disabled agents have no image to prepare.
 */
export function describeAgentCliVersionStates(configs: AgentConfig[], registry: RegistryView): AgentCliVersionState[] {
    const image = registry.getOperationalStatus().unifiedAgentImage;
    return configs.filter(config => config.enabled).map(config => {
        const live = registry.getAgentByAlias(config.alias);
        const effective = live && live.config.type === config.type ? configuredCliVersion(live.config) : null;
        const configuredVersion = configuredCliVersion(config);
        const base = { agentId: config.id, alias: config.alias, type: config.type, configuredVersion, effectiveVersion: effective };
        // A matching live version is in effect even while another agent's
        // change is still being prepared.
        if (effective && effective === configuredVersion) return { ...base, status: 'ready' as const };
        if (preparationFailed(image)) {
            const nextRetryAt = nextAutomaticRetryAt(image);
            return {
                ...base,
                status: 'failed' as const,
                ...(image.error ? { error: image.error } : {}),
                ...(nextRetryAt ? { nextRetryAt } : {}),
                automaticRetry: !image.operatorActionRequired,
            };
        }
        return { ...base, status: 'preparing' as const };
    });
}

/** Operator-facing warnings for agents whose configured CLI version is not in effect yet. */
export function agentCliVersionWarnings(states: AgentCliVersionState[]): string[] {
    return states.flatMap(state => {
        if (state.status === 'ready' || state.configuredVersion === state.effectiveVersion) return [];
        const current = state.effectiveVersion
            ? `Runs keep using ${state.type} CLI ${state.effectiveVersion} until it is ready.`
            : 'Runs for this agent cannot start until it is ready.';
        if (state.status === 'failed') {
            return [`Agent '${state.alias}': preparing the image for ${state.type} CLI ${state.configuredVersion} failed${state.error ? ` (${state.error})` : ''}. ${current}`];
        }
        return [`Agent '${state.alias}': the worker is preparing the image for ${state.type} CLI ${state.configuredVersion}; this can take several minutes. ${current}`];
    });
}
