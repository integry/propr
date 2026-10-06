import type { AgentCapability } from '@propr/shared';
import type { AgentTaskOptions, IssueRef, StoredAgentDefinition } from '@propr/core';
import { definitionReadsRepositories, type AgentRunWorkspace } from './workspace.js';

/**
 * Capability-derived tool restrictions for the report run; enforced by agents once issue 8 lands.
 * Repository access is already enforced at launch through `repositoryAccess`.
 */
export interface AgentRunToolPolicy {
    capabilities: AgentCapability[];
    /** The report run never writes to the repository or GitHub. */
    readOnly: true;
}

/** Launch options for the report run's agent. */
export function agentTaskOptions(input: {
    runId: string;
    taskId: string;
    definition: StoredAgentDefinition;
    issueRef: IssueRef;
    prompt: string;
    model: string | undefined;
    token: string;
    workspace: AgentRunWorkspace;
}): AgentTaskOptions & { toolPolicy: AgentRunToolPolicy } {
    const { runId, taskId, definition, issueRef, prompt, model, token, workspace } = input;
    const repositoryReadable = definitionReadsRepositories(definition) && workspace.promptWorkspace.repositoriesReadable;
    const toolPolicy: AgentRunToolPolicy = { capabilities: [...definition.capabilities], readOnly: true };
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
