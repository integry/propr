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
