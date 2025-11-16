export function generateClaudePrompt(issueRef, branchName = null, modelName = null, issueDetails = null) {
    const branchInfo = branchName ? `\n- **BRANCH**: You are working on branch \`${branchName}\`.` : '';
    const modelInfo = modelName ? `\n- **MODEL**: This task is being processed by the \`${modelName}\` model.` : '';

    let issueDetailsSection = '';
    if (issueDetails) {
        issueDetailsSection = `

**ISSUE DETAILS (Pre-fetched for reliability):**

**Title:** ${issueDetails.title || 'N/A'}

**Description:**
${issueDetails.body || 'No description provided'}

**Labels:** ${issueDetails.labels?.map(l => l.name).join(', ') || 'None'}

**Created by:** @${issueDetails.user?.login || 'unknown'}
**Created at:** ${issueDetails.created_at || 'unknown'}`;

        if (issueDetails.comments && issueDetails.comments.length > 0) {
            issueDetailsSection += `\n\n**Comments (${issueDetails.comments.length} total):**\n`;
            issueDetails.comments.forEach((comment, index) => {
                issueDetailsSection += `\n---\n**Comment ${index + 1}** by @${comment.user?.login || 'unknown'} (${comment.created_at || 'unknown'}):\n${comment.body || 'Empty comment'}\n`;
            });
        } else {
            issueDetailsSection += `\n\n**Comments:** No comments on this issue yet.`;
        }

        issueDetailsSection += `\n\n**Note:** The above issue details have been automatically injected. You can still use \`gh issue view ${issueRef.number}\` if you need to fetch any additional information or verify the details.`;
    }

    return `Please analyze and implement a solution for GitHub issue #${issueRef.number}.

**REPOSITORY INFORMATION:**
- Repository Owner: ${issueRef.repoOwner}
- Repository Name: ${issueRef.repoName}
- Full Repository: ${issueRef.repoOwner}/${issueRef.repoName}${branchInfo}${modelInfo}${issueDetailsSection}

**YOUR FOCUS: IMPLEMENTATION ONLY**

The git workflow (branching, committing, pushing, PR creation) is handled automatically by the system. Your job is to focus solely on implementing the solution.

Follow these steps systematically:
1. ${issueDetails ? 'Review the pre-fetched issue details above' : `Use \`gh issue view ${issueRef.number}\` to get the issue details`}
2. ${issueDetails ? '(Optional)' : ''} Use \`gh issue view ${issueRef.number} --comments\` to ${issueDetails ? 'fetch any additional comments or verify the information' : 'read all issue comments for additional context'}
3. **Pay attention to any images, screenshots, or attachments** in the issue description and comments - these often contain crucial visual information like UI mockups, error screenshots, or design specifications
4. Understand the complete problem described in the issue, comments, and any visual materials
5. Search the codebase to understand the current implementation
6. Implement the necessary changes to solve the issue
7. Test your implementation (if applicable and possible)
8. Ensure code follows existing patterns and conventions

**IMPORTANT NOTES:**
- **DO NOT** worry about git operations (add, commit, push, PR creation)
- **DO NOT** use git commands or GitHub CLI for workflow operations
- **FOCUS ONLY** on implementing the solution to the problem
- You are working in a git worktree environment with the codebase ready
- Make your changes directly to the files that need modification
- The system will automatically handle committing, pushing, and creating a PR
- Include a brief summary of what you implemented when you're done

**SUCCESS CRITERIA:**
Your task is complete when you have implemented a working solution to the issue. The git workflow and PR creation will be handled automatically by the system after your implementation.`;
}

export function generateTaskImportPrompt(taskDescription, repoOwner, repoName, worktreePath) {
    return `You are an expert software analyst. Your task is to convert code change requests into detailed GitHub issue specifications for the **${repoOwner}/${repoName}** repo, so a junior developer can implement them. If the issue specification with comments is already defined, publish it directly to Github without modifications, otherwise carefully analyze the request first and then publish the issues.

You are working in a git worktree at '${worktreePath}' which contains the full source code for analysis and planning.

You MUST publish issues and their respective comments using gh commands:

1. **Create an Issue:** The issue body must contain:
   * A detailed task description and context.
   * Clear, step-by-step implementation instructions.
2. **Add a Comment:** After creating the issue and capturing its ID/number, add a separate comment to that issue containing the suggested implementation code (use diffs where possible).
3. **Multi-Issue Tasks:** If the work is significant, break it into multiple issues. When doing so, the issue description must reference the previous issue ID and describe the epic's overall goal and current stage. Prefer a single issue when possible.

**YOUR FOCUS: ANALYSIS AND 'gh' COMMANDS ONLY**
- You have read-only access to the codebase for planning.
- DO NOT implement any code changes.
- DO NOT use git commands (add, commit, push).
- Your *only* output should be the bash script using 'gh' commands to create the issues.

Here is the user's request:
---
${taskDescription}
---`;
}

export function generateExecutionAnalysisPrompt(originalPrompt, conversationLog, model, localDiff) {
    const conversationSummary = conversationLog.map((entry, index) => {
        const eventType = entry.event_type || 'unknown';
        const content = entry.content ? entry.content.substring(0, 500) : 'N/A';
        const toolName = entry.tool_name || 'N/A';
        const isError = entry.is_error || false;
        
        return `[${index + 1}] Type: ${eventType}, Tool: ${toolName}, Error: ${isError}, Content Preview: ${content}...`;
    }).join('\n');

    let analysisPrompt = `You are an expert AI assistant analyzing the execution of another AI assistant's work on a coding task.

**ORIGINAL TASK PROMPT:**
${originalPrompt}

**CONVERSATION LOG (${conversationLog.length} total events):**
${conversationSummary}`;

    if (localDiff) {
        analysisPrompt += `\n\n**COMMIT DIFF:**
Here is the full commit data (including diff) for the implementation.
<commit_diff>
${localDiff}
</commit_diff>`;
    }

    analysisPrompt += `\n\n**YOUR TASK:**
Analyze this execution and provide a structured report covering:

1. **Efficiency Assessment:** How efficiently did the AI handle this task? Were there unnecessary steps or redundant actions?
2. **Tool Usage Analysis:** Which tools were used most frequently? Were they used appropriately?
3. **Error Analysis:** Were there any errors or failures? If so, how were they handled?
4. **Prompt Quality:** How well did the original prompt guide the AI? Could it be improved?
5. **Implementation Critique:** ${localDiff ? 'YOU MUST include this section. Perform a brief code review of the diff found within the commit data. Analyze its correctness, how well it implements the solution, and identify any potential bugs or improvements.' : 'State "No local commit diff was available for this execution."'}
6. **Recommendations:** Suggest 2-3 specific improvements for similar future tasks.

**OUTPUT FORMAT:**
Provide your analysis in JSON format:
{
  "efficiency_score": <1-10>,
  "efficiency_notes": "<brief assessment>",
  "tool_usage_summary": {
    "most_used_tools": ["tool1", "tool2"],
    "tool_appropriateness": "<assessment>"
  },
  "error_analysis": "<summary of errors if any>",
  "prompt_quality_score": <1-10>,
  "prompt_improvements": "<suggestions>",
  "implementation_critique": "<code review of the commit diff>",
  "recommendations": [
    "<recommendation 1>",
    "<recommendation 2>",
    "<recommendation 3>"
  ]
}

Respond ONLY with the JSON object, no other text.`;

    return analysisPrompt;
}
