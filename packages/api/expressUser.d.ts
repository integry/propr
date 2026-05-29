import type { GitHubUser } from './authTypes.js';

declare global {
    namespace Express {
        interface User extends GitHubUser {
            githubAuthInvalid?: GitHubUser['githubAuthInvalid'];
        }
    }
}

export {};
