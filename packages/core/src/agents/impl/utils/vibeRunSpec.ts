import { buildAgentGitCredentialArgs, buildAgentGitMountArgs } from '../../agentGitAccess.js';
import { resolveAgentContainerResources } from '../../agentContainerResources.js';
import { AgentRunSpecBuilder, agentRunMcpGrant, agentRunNetwork } from '../../runtime/agentRunSpec.js';
import type { AgentRunSpec } from '../../runtime/types.js';
import type { AgentConfig, AgentToolPolicy } from '../../types.js';
import { agentContainerNetwork } from '../../agentContainerNetwork.js';
import { applyAgentRunLaunchWrapper } from '../../../claude/docker/repoSetupWrapper.js';
import { vibeAnalysisSandbox } from './vibeAgentHelpers.js';
import { REPOSITORY_SCOUT_CONTAINER_ROOT } from './repositoryScoutMcpServer.js';

export interface VibeRunSpecInput {
    config: AgentConfig;
    name: string;
    mode: 'execute' | 'analysis';
    worktreePath: string;
    repositoryInspection: boolean;
    gitMountArgs?: string[];
    configMountArgs: string[];
    promptMountArgs: string[];
    runtimeHomeMountArgs: string[];
    envFilePath?: string;
    envVars: string[];
    cliArgs: string[];
    /** Task runs only: the MCP catalog, skills and the exclusive switch. */
    toolPolicy?: AgentToolPolicy;
}

/** The Vibe run: stdin closed (the prompt is a mounted file), a read-only sandbox for analysis. */
export function assembleVibeRunSpec(input: VibeRunSpecInput): AgentRunSpec {
    const { config, mode, worktreePath, repositoryInspection } = input;
    const sandbox = vibeAnalysisSandbox(mode);
    const builder = new AgentRunSpecBuilder({
        agentType: 'vibe', image: config.dockerImage, alias: config.alias, name: input.name, stdin: false,
        // Execute runs start as root like every other agent: the setup wrapper and the clone
        // workspace transport need root to keep the agent (dropped to node by the entrypoint)
        // under a different user ID from their credentials. Analysis keeps the image user in
        // its read-only, capability-free sandbox; it always uses the read-only bind transport.
        ...(mode === 'execute' ? { user: '0:0' } : {}),
        network: agentRunNetwork(agentContainerNetwork(input.toolPolicy)),
        mcpGrant: agentRunMcpGrant(input.toolPolicy),
        security: { readOnlyRootFilesystem: sandbox.readOnlyRootFilesystem, capDrop: sandbox.capDrop, capAdd: mode === 'execute' ? ['CHOWN'] : [] },
        workspace: {
            hostPath: worktreePath,
            containerPath: repositoryInspection ? REPOSITORY_SCOUT_CONTAINER_ROOT : '/home/node/workspace',
            readOnly: mode === 'analysis',
        },
    });
    for (const [target, options] of sandbox.tmpfs) builder.tmpfs(target, options);
    builder.workspaceMount();
    if (!repositoryInspection) builder.dockerOptions(input.gitMountArgs ?? buildAgentGitMountArgs(worktreePath, false, mode === 'analysis'), 'git');
    const configMountsFrom = builder.spec.mounts.length;
    builder.dockerOptions(input.configMountArgs, 'credential');
    for (const mount of builder.spec.mounts.slice(configMountsFrom)) {
        if (mount.type === 'bind') builder.markCredentialStore(mount.target, { provider: 'vibe', store: 'config', perRun: true });
    }
    builder
        .dockerOptions(input.promptMountArgs, 'prompt')
        .dockerOptions(input.runtimeHomeMountArgs, 'runtime-home');
    if (input.envFilePath) builder.envFile(input.envFilePath);
    builder
        .dockerOptions(input.envVars, 'credential')
        .dockerOptions(buildAgentGitCredentialArgs(), 'credential')
        .command(...input.cliArgs);
    const spec = builder.build();
    // Analysis runs have no repository setup hook, only the resource boundary.
    if (mode === 'analysis') return Object.assign(spec, { resources: resolveAgentContainerResources() });
    return applyAgentRunLaunchWrapper(spec, 'vibe');
}
