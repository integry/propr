import type { GitHubUser } from './authTypes.js';

declare global {
    namespace Express {
        // eslint-disable-next-line @typescript-eslint/no-empty-object-type
        interface User extends GitHubUser {}
    }
}

export {};
