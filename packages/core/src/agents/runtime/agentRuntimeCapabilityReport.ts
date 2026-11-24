import type { InstanceNetworkPolicy } from '../../network/networkPolicy.js';
import { planAgentRunMcpTransport, type AgentRunMcpTransportPlan } from './agentRunMcpTransport.js';
import { AGENT_RUNTIME_ENV, getAgentRuntime, registeredAgentRuntimes, restrictedNetworkRefusal, runtimeSupportsMcpReachableUrl } from './registry.js';
import type { AgentRuntimeRestrictedNetworkEnforcement } from './types.js';

/**
 * What the instance's default agent runtime can enforce, for the admission
 * report (`GET /api/agent-run-admission`, `get_agent_run_admission`,
 * `propr admission`). Admission refuses a run whose spec needs a capability
 * its runtime lacks; this says in advance which runs that will be, so an
 * operator sees "restricted runs are refused on runtime X" before a run fails.
 *
 * An agent's own `runtime` setting can select another runtime; its runs are
 * checked against that runtime at launch the same way.
 */
export interface AgentRuntimeCapabilityReport {
    runtime: string;
    selectedBy: typeof AGENT_RUNTIME_ENV | 'default';
    registered: string[];
    capabilities: {
        bindMounts: boolean;
        restrictedNetwork: boolean;
        mcpPrivateNetwork: boolean;
        mcpReachableUrl: boolean;
        reattach: boolean;
    };
    network: {
        /** The instance network mode; null when the policy could not be read (runs then fail closed). */
        instanceMode: InstanceNetworkPolicy['mode'] | null;
        enforced: boolean | null;
        /** `enforced`: restricted runs are confined; `refused`: they are refused before launch. */
        restrictedRuns: 'enforced' | 'refused';
        enforcement: AgentRuntimeRestrictedNetworkEnforcement | null;
        /** The error restricted runs get on this runtime. */
        refusal?: string;
        /**
         * True when the instance policy is restricted *and enforced* and this
         * runtime refuses such runs: every run is restricted, so runs are
         * being refused now. A restricted default that is not enforced
         * applies only where a run's effective policy stays restricted (an
         * enclosing automation or workflow policy that does not choose open),
         * so it is reported as conditional refusal, not this flag.
         */
        refusingRuns: boolean;
        unavailable?: string;
    };
    mcp: { transport: AgentRunMcpTransportPlan['transport']; reason: string };
}

export interface AgentRuntimeCapabilityReportOptions {
    environment?: NodeJS.ProcessEnv;
    /** Reads the instance network policy; defaults to the persisted Settings policy. */
    loadPolicy?: () => Promise<InstanceNetworkPolicy>;
}

async function defaultLoadPolicy(): Promise<InstanceNetworkPolicy> {
    const { loadInstanceNetworkPolicy } = await import('../../config/configManagerAgentNetwork.js');
    return loadInstanceNetworkPolicy();
}

export async function readAgentRuntimeCapabilityReport(options: AgentRuntimeCapabilityReportOptions = {}): Promise<AgentRuntimeCapabilityReport> {
    const environment = options.environment ?? process.env;
    const runtime = getAgentRuntime(null, environment);
    const { capabilities } = runtime;
    let policy: InstanceNetworkPolicy | null = null;
    let unavailable: string | undefined;
    try {
        policy = await (options.loadPolicy ?? defaultLoadPolicy)();
    } catch {
        unavailable = 'The instance network policy could not be read; agent runs fail closed until it can.';
    }
    const refusal = restrictedNetworkRefusal(runtime);
    const mcp = planAgentRunMcpTransport(runtime, environment);
    return {
        runtime: runtime.kind,
        selectedBy: environment[AGENT_RUNTIME_ENV]?.trim() ? AGENT_RUNTIME_ENV : 'default',
        registered: registeredAgentRuntimes(),
        capabilities: {
            bindMounts: capabilities.supportsBindMounts,
            restrictedNetwork: capabilities.supportsRestrictedNetwork,
            mcpPrivateNetwork: capabilities.supportsMcpPrivateNetwork,
            mcpReachableUrl: runtimeSupportsMcpReachableUrl(capabilities),
            reattach: capabilities.reattach,
        },
        network: {
            instanceMode: policy?.mode ?? null,
            enforced: policy ? policy.enforced : null,
            restrictedRuns: refusal ? 'refused' : 'enforced',
            enforcement: capabilities.supportsRestrictedNetwork ? capabilities.restrictedNetworkEnforcement ?? null : null,
            ...(refusal ? { refusal } : {}),
            refusingRuns: !!refusal && policy?.mode === 'restricted' && policy.enforced,
            ...(unavailable ? { unavailable } : {}),
        },
        mcp: { transport: mcp.transport, reason: mcp.reason },
    };
}
