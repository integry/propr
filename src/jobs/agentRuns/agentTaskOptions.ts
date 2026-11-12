import type { AgentTaskOptions, IssueRef, StoredAgentDefinition } from '@propr/core';
import { definitionReadsRepositories, type AgentRunWorkspace } from './workspace.js';
import { agentRunToolPolicy, type AgentRunMcpGrant, type AgentRunPhase } from './toolPolicy.js';

/** Launch options for the agent of one run phase. */
export function agentTaskOptions(input: {
    runId: string;
    taskId: string;
    definition: StoredAgentDefinition;
    issueRef: IssueRef;
    prompt: string;
    model: string | undefined;
    token: string;
    workspace: AgentRunWorkspace;
    /** Run-scoped ProPR MCP credential, when one was issued. */
    mcpGrant?: AgentRunMcpGrant | null;
    /** Defaults to the report phase. */
    phase?: AgentRunPhase;
}): AgentTaskOptions {
    const { runId, taskId, definition, issueRef, prompt, model, token, workspace, mcpGrant, phase = 'report' } = input;
    const repositoryReadable = definitionReadsRepositories(definition) && workspace.promptWorkspace.repositoriesReadable;
    // Web and MCP are enforced by the runtime; repository access through `repositoryAccess`.
    const toolPolicy = agentRunToolPolicy({ phase, capabilities: definition.capabilities, mcpGrant });
    return {
        // Library items that apply automatically plus the automation's added ones,
        // resolved against the current library revision at launch.
        extensions: {
            autoApply: true,
            servers: [...(definition.extensions?.servers ?? [])],
            skills: [...(definition.extensions?.skills ?? [])],
            repositories: definition.repositories,
            allowWrite: phase === 'action',
        },
        worktreePath: workspace.worktreePath,
        issueRef,
        prompt,
        model,
        // Without repository_read the adapter mounts no clones and mints no repository token.
        githubToken: repositoryReadable ? token : '',
        ...(repositoryReadable ? {} : { repositoryAccess: 'none' as const }),
        branchName: workspace.branchName,
        taskId,
        toolPolicy,
        metadata: { agentRunId: runId, agentDefinitionId: definition.id },
    };
}

/**
 * The execution step of a run phase, recording the agent and model it
 * actually resolved: a definition without an alias or model runs on defaults
 * that may change later, so the task's identity comes from this record. An
 * unresolved model is left unrecorded rather than guessed.
 */
export function agentRunExecutionUpdate(alias: string, model: string | undefined): { reason: string; historyMetadata?: Record<string, unknown> } {
    const reason = `Running agent ${alias}`;
    if (!model) return { reason };
    return { reason, historyMetadata: { model, executionRouting: { model, agentAlias: alias } } };
}

/**
 * Whether extension library items apply to this launch, so the run executes
 * under the network-policy scope they need. Agents without a configuration
 * (and runs without an extension request) never carry extensions.
 */
export async function launchCarriesExtensions(resolved: { agent: unknown }, options: AgentTaskOptions): Promise<boolean> {
    const config = (resolved.agent as { config?: { alias: string; type: string } }).config;
    if (!config || !options.extensions) return false;
    // Lazily loaded: the extension launch module is only needed for runs that can carry extensions.
    const { extensionsApply } = await import('@propr/core');
    return extensionsApply(config as Parameters<typeof extensionsApply>[0], options);
}
