/* eslint-disable @typescript-eslint/no-empty-object-type */
import type { GitHubUser } from './authTypes.js';
import type { InstanceAuthorization } from './authorization.js';

declare global {
    namespace Express {
        interface User extends GitHubUser {}
        interface Request {
            authorization?: InstanceAuthorization;
        }
    }
}

export {};
