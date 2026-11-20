import type { AgentRegistryOperationalStatus } from './agentRegistryTypes.js';
import type { Agent, AgentConfig } from './types.js';
import { AGENT_DEFAULT_VERSIONS } from './version/types.js';
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
    /** When the next automatic preparation attempt is due after a failure. */
    nextRetryAt?: string;
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
            return {
                ...base,
                status: 'failed' as const,
                ...(image.error ? { error: image.error } : {}),
                ...(image.nextRetryAt && !image.circuitBreakerOpen ? { nextRetryAt: image.nextRetryAt } : {}),
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
