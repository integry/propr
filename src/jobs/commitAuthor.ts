// Re-export the single source of truth from core so the agent commit author
// identity (and its env-var defaults) cannot drift between the two packages.
export { AI_COMMIT_AUTHOR } from '@propr/core';
