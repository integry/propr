// Compatibility export for route modules that historically imported GitHubUser
// from authUser.ts instead of authTypes.ts.
export type { GitHubUser } from './authTypes.js';
