/**
 * GitHub issue job module exports.
 */

// Types
export * from './types.js';

// Config
export { redisClient, DEFAULT_MODEL_NAME, getPrimaryProcessingLabels, getPrLabel } from './config.js';

// Context
export { initializeJobContext } from './context.js';

// GitHub operations
export { getAuthenticatedClient, checkLabelConditions, fetchIssueComments } from './github.js';

// Agent execution
export { toClaudeResult, agentResultToClaudeResponse, executeAgentAndRecordMetrics } from './agent.js';

// Completion
export { markTaskComplete } from './completion.js';

// Worktree operations
export { executeWorktreeOperations } from './worktree.js';
