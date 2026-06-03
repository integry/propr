/* eslint-disable @typescript-eslint/no-empty-object-type */
import type { GitHubUser } from './authTypes.js';

declare global {
    namespace Express {
        interface User extends GitHubUser {}
    }
}

export {};
