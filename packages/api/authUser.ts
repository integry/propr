declare global {
    // eslint-disable-next-line @typescript-eslint/no-namespace
    namespace Express {
        interface User {
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
    }
}

export type GitHubUser = Express.User;
