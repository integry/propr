export interface GitHubUser {
    id: string;
    login?: string;
    username: string;
    displayName: string;
    email: string | null;
    avatarUrl: string | null;
    accessToken?: string;
    refreshToken?: string;
    tokenExpiresAt?: number;
    githubAuthInvalid?: boolean;
}

export interface AllowedRedirectHost {
    host: string;
    includeSubdomains: boolean;
}

declare global {
    // eslint-disable-next-line @typescript-eslint/no-namespace
    namespace Express {
        // eslint-disable-next-line @typescript-eslint/no-empty-object-type
        interface User extends GitHubUser {}
    }
}
