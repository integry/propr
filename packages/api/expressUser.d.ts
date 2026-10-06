/* eslint-disable @typescript-eslint/no-empty-object-type */
import type { GitHubUser } from './authTypes.js';
import type { InstanceAuthorization } from './authorization.js';

declare global {
    namespace Express {
        interface User extends GitHubUser {}
        interface Request {
            authorization?: InstanceAuthorization;
            /** `mcp` marks a workflow handler called by an MCP tool for its verified principal. */
            authenticationMethod?: 'session' | 'github_bearer' | 'instance_token' | 'demo' | 'mcp';
            instanceTokenId?: string;
        }
    }
}

export {};
