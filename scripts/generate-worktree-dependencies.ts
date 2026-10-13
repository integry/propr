import { generateManagedDependencies } from '../packages/core/src/storage/managedDependencies.js';
const [worktree, ...extra] = process.argv.slice(2);
if (!worktree || extra.length) throw new Error('Usage: npx tsx scripts/generate-worktree-dependencies.ts <managed-worktree>');
await generateManagedDependencies(worktree);
console.log('Managed dependency payload generated. Cleanup remains opt-in and requires completed lifecycle plus 24 hours of actual inactivity.');
