declare namespace Express {
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
