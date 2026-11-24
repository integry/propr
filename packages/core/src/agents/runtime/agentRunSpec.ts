import type { AgentToolPolicy, AgentType } from '../types.js';
import type {
    AgentRunCredentialStore, AgentRunMcpGrant, AgentRunMount, AgentRunMountPurpose, AgentRunNetwork, AgentRunSecurity, AgentRunSpec, AgentRunWorkspace,
} from './types.js';

export interface AgentRunSpecInit {
    agentType: AgentType;
    image: string;
    alias?: string;
    name: string;
    stdin: boolean;
    workdir?: string;
    user?: string;
    workspace: AgentRunWorkspace;
    network: AgentRunNetwork;
    security?: Partial<AgentRunSecurity>;
    mcpGrant?: AgentRunMcpGrant;
}

export const AGENT_WORKSPACE_PATH = '/home/node/workspace';

/** `bridge` unless the run must join a named network (an MCP grant's Compose network). */
export function agentRunNetwork(name: string): AgentRunNetwork {
    return { mode: name === 'bridge' ? 'bridge' : 'named', name };
}

/**
 * The MCP grant a tool policy gives a run: server names plus how they are
 * reached, over the private network the policy names, or else at a URL the
 * runtime's default network reaches (authenticated by the per-run token).
 */
export function agentRunMcpGrant(policy: Pick<AgentToolPolicy, 'mcpServers' | 'dockerNetwork'> | undefined): AgentRunMcpGrant | undefined {
    if (!policy?.mcpServers?.length) return undefined;
    const network = policy.dockerNetwork?.trim();
    return {
        servers: policy.mcpServers.map(server => server.name),
        ...(network ? { network } : {}),
        transport: network ? 'private-network' : 'reachable-url',
    };
}

/**
 * Assembles an {@link AgentRunSpec} in declaration order. Every environment
 * variable, mount and env file receives the next `order`, so the Docker
 * renderer reproduces the provider's flag sequence exactly.
 */
export class AgentRunSpecBuilder {
    readonly spec: AgentRunSpec;
    private nextOrder = 0;

    constructor(init: AgentRunSpecInit) {
        this.spec = {
            profile: { agentType: init.agentType, image: init.image, ...(init.alias ? { alias: init.alias } : {}) },
            name: init.name,
            args: [],
            stdin: init.stdin,
            workdir: init.workdir ?? AGENT_WORKSPACE_PATH,
            ...(init.user ? { user: init.user } : {}),
            workspace: init.workspace,
            env: [],
            mounts: [],
            envFiles: [],
            network: init.network,
            security: {
                noNewPrivileges: true, securityOpts: [], capAdd: [], capDrop: [], readOnlyRootFilesystem: false,
                ...init.security,
            },
            ...(init.mcpGrant ? { mcpGrant: init.mcpGrant } : {}),
            labels: {},
        };
    }

    private order(): number { return this.nextOrder++; }

    /** The workspace bind declared in `spec.workspace`. */
    workspaceMount(): this {
        const { hostPath, containerPath, readOnly } = this.spec.workspace;
        return this.bind(hostPath, containerPath, readOnly, 'workspace');
    }

    bind(source: string, target: string, readOnly: boolean, purpose: AgentRunMountPurpose): this {
        this.spec.mounts.push({ type: 'bind', source, target, readOnly, purpose, order: this.order() });
        return this;
    }

    /** A bind of a provider credential store; the runtime may substitute a per-run copy. */
    credentialBind(source: string, target: string, readOnly: boolean, credentialStore: AgentRunCredentialStore): this {
        const purpose: AgentRunMountPurpose = credentialStore.store === 'data' ? 'data' : 'credential';
        this.spec.mounts.push({ type: 'bind', source, target, readOnly, purpose, order: this.order(), credentialStore });
        return this;
    }

    /** Tag an already-declared bind (e.g. one adopted from Docker argv) as a credential store. */
    markCredentialStore(target: string, credentialStore: AgentRunCredentialStore): this {
        for (const mount of this.spec.mounts) {
            if (mount.type === 'bind' && mount.target === target) mount.credentialStore = credentialStore;
        }
        return this;
    }

    /** A bind that must fail when its source is missing (Docker `--mount`, never auto-created). */
    strictBind(source: string, target: string, readOnly: boolean, purpose: AgentRunMountPurpose): this {
        this.spec.mounts.push({ type: 'bind', source, target, readOnly, purpose, order: this.order(), syntax: 'mount' });
        return this;
    }

    tmpfs(target: string, options: string, purpose: AgentRunMountPurpose = 'scratch'): this {
        this.spec.mounts.push({ type: 'tmpfs', target, options, purpose, order: this.order() });
        return this;
    }

    /** Omit `value` to pass the variable through from the launching process. */
    env(name: string, value?: string): this {
        this.spec.env.push({ name, ...(value === undefined ? {} : { value }), order: this.order() });
        return this;
    }

    envFile(path: string): this {
        this.spec.envFiles.push({ path, order: this.order() });
        return this;
    }

    /**
     * Adopt container options still produced as Docker argv by shared helpers
     * (prepared git mounts, forwarded variables). Only `-v`, `-e`, `--tmpfs`
     * and `--env-file` are accepted; anything else is a programming error.
     */
    dockerOptions(args: readonly string[], purpose: AgentRunMountPurpose): this {
        for (let index = 0; index < args.length; index += 2) {
            const flag = args[index];
            const value = args[index + 1];
            if (value === undefined) throw new Error(`Docker option ${flag} has no value`);
            if (flag === '-v') this.adoptVolume(value, purpose);
            else if (flag === '-e') {
                const separator = value.indexOf('=');
                if (separator < 0) this.env(value);
                else this.env(value.slice(0, separator), value.slice(separator + 1));
            } else if (flag === '--tmpfs') {
                const separator = value.indexOf(':');
                if (separator < 0) throw new Error(`Unsupported tmpfs option: ${value}`);
                this.tmpfs(value.slice(0, separator), value.slice(separator + 1), purpose);
            } else if (flag === '--env-file') this.envFile(value);
            else throw new Error(`Unsupported Docker option in agent run spec: ${flag}`);
        }
        return this;
    }

    private adoptVolume(value: string, purpose: AgentRunMountPurpose): void {
        const modeSeparator = value.lastIndexOf(':');
        const mode = value.slice(modeSeparator + 1);
        const targetSeparator = value.lastIndexOf(':', modeSeparator - 1);
        if (modeSeparator < 0 || targetSeparator < 0 || (mode !== 'ro' && mode !== 'rw')) {
            throw new Error(`Unsupported volume option in agent run spec: ${value}`);
        }
        this.bind(value.slice(0, targetSeparator), value.slice(targetSeparator + 1, modeSeparator), mode === 'ro', purpose);
    }

    command(...args: string[]): this {
        this.spec.args.push(...args);
        return this;
    }

    build(): AgentRunSpec {
        return this.spec;
    }
}

/** Environment variables in declaration order, as a runtime without positional flags consumes them. */
export function agentRunEnvironment(spec: AgentRunSpec): Record<string, string | undefined> {
    const environment: Record<string, string | undefined> = {};
    for (const variable of [...(spec.repoSetup?.env ?? []), ...[...spec.env].sort((a, b) => a.order - b.order)]) {
        environment[variable.name] = variable.value;
    }
    return environment;
}

export function agentRunMounts(spec: AgentRunSpec, purpose?: AgentRunMount['purpose']): AgentRunMount[] {
    return spec.mounts.filter(mount => !purpose || mount.purpose === purpose).sort((a, b) => a.order - b.order);
}
