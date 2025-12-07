import type { Redis } from 'ioredis';
type Octokit = {
    paginate: <T>(endpoint: string, options: Record<string, unknown>) => Promise<T[]>;
};
interface PollingConfig {
    redisClient: Redis;
    GITHUB_BOT_USERNAME?: string;
    PR_FOLLOWUP_TRIGGER_KEYWORDS: string[];
    MODEL_LABEL_PATTERN: string;
}
export declare function pollForPullRequestComments(octokit: Octokit, repoFullName: string, correlationId: string, config: PollingConfig): Promise<void>;
export {};
