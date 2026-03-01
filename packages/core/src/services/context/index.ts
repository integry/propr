/**
 * Context service module.
 * Re-exports all context-related types and functions.
 */

// Types
export * from './types.js';

// File selection
export { selectFilesWithinLimit } from './fileSelection.js';

// Optimized context generation
export { generateOptimizedContext } from './optimizedContext.js';

// Main context generation
export { generateContext } from './generateContext.js';

// Additional context from external repositories
export { generateAdditionalContext } from './additionalContext.js';
export type { AdditionalContextOptions, AdditionalContextResult } from './additionalContext.js';
