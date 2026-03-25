import { mock } from 'node:test';

// ========== Mock Octokit Factory ==========

/**
 * Type definition for mock Octokit instance.
 * Matches the Octokit type used throughout the codebase.
 */
export interface MockOctokit {
    request: ReturnType<typeof mock.fn<(endpoint: string, options?: Record<string, unknown>) => Promise<{ data: Record<string, unknown> }>>>;
}

/**
 * Extended mock Octokit with paginate support for listing operations.
 */
export interface MockOctokitWithPaginate extends MockOctokit {
    paginate: ReturnType<typeof mock.fn<(endpoint: string, options?: Record<string, unknown>) => Promise<unknown[]>>>;
}

/**
 * Configuration options for creating mock Octokit instances.
 */
export interface CreateMockOctokitOptions {
    /**
     * Custom implementation for the request method.
     * If not provided, returns `{ data: {} }` by default.
     */
    requestImpl?: (endpoint: string, options?: Record<string, unknown>) => Promise<{ data: Record<string, unknown> }>;
    /**
     * Whether to include the paginate method for listing operations.
     * Defaults to false.
     */
    withPaginate?: boolean;
    /**
     * Custom implementation for the paginate method (only used if withPaginate is true).
     * If not provided, returns an empty array by default.
     */
    paginateImpl?: (endpoint: string, options?: Record<string, unknown>) => Promise<unknown[]>;
}

/**
 * Creates a typed mock Octokit instance for testing GitHub API interactions.
 *
 * @param options - Configuration options for the mock
 * @returns A typed mock Octokit instance
 *
 * @example
 * // Basic usage - returns { data: {} } for all requests
 * const mockOctokit = createMockOctokit();
 *
 * @example
 * // With custom request implementation
 * const mockOctokit = createMockOctokit({
 *     requestImpl: async (endpoint, options) => {
 *         if (endpoint.includes('issues')) {
 *             return { data: { number: 123 } };
 *         }
 *         return { data: {} };
 *     }
 * });
 *
 * @example
 * // With paginate support for listing operations
 * const mockOctokit = createMockOctokit({
 *     withPaginate: true,
 *     paginateImpl: async () => [{ id: 1 }, { id: 2 }]
 * });
 *
 * @example
 * // Verifying calls made to the mock
 * const mockOctokit = createMockOctokit();
 * await mockOctokit.request('POST /repos/{owner}/{repo}/issues', { owner: 'test', repo: 'repo' });
 * assert.strictEqual(mockOctokit.request.mock.calls.length, 1);
 */
export function createMockOctokit(options?: CreateMockOctokitOptions & { withPaginate: true }): MockOctokitWithPaginate;
export function createMockOctokit(options?: CreateMockOctokitOptions & { withPaginate?: false }): MockOctokit;
export function createMockOctokit(options?: CreateMockOctokitOptions): MockOctokit | MockOctokitWithPaginate {
    const defaultRequestImpl = async (): Promise<{ data: Record<string, unknown> }> => ({ data: {} });
    const defaultPaginateImpl = async (): Promise<unknown[]> => [];

    const requestImpl = options?.requestImpl ?? defaultRequestImpl;
    const mockRequest = mock.fn(requestImpl);

    if (options?.withPaginate) {
        const paginateImpl = options.paginateImpl ?? defaultPaginateImpl;
        const mockPaginate = mock.fn(paginateImpl);
        return {
            request: mockRequest,
            paginate: mockPaginate
        } as MockOctokitWithPaginate;
    }

    return {
        request: mockRequest
    } as MockOctokit;
}

/**
 * Resets all mock calls on a mock Octokit instance.
 * Useful in beforeEach hooks to clear call history between tests.
 *
 * @param mockOctokit - The mock Octokit instance to reset
 *
 * @example
 * beforeEach(() => {
 *     resetMockOctokit(mockOctokit);
 * });
 */
export function resetMockOctokit(mockOctokit: MockOctokit | MockOctokitWithPaginate): void {
    mockOctokit.request.mock.resetCalls();
    if ('paginate' in mockOctokit) {
        mockOctokit.paginate.mock.resetCalls();
    }
}

// ========== LLM Metrics Mock ==========

interface LLMMetricsSummary {
    summary: {
        totalRequests: number;
        totalSuccessful: number;
        totalFailed: number;
        successRate: number;
        totalCostUsd: number;
        avgCostPerRequest: number;
        totalTurns: number;
        avgTurnsPerRequest: number;
        avgExecutionTimeSec: number;
    };
    modelBreakdown: Record<string, unknown>;
    dailyMetrics: unknown[];
    recentHighCostAlerts: unknown[];
    lastUpdated: string;
}

export const mockRecordLLMMetrics = mock.fn(async () => {
});

export const llmMetricsMock = {
    recordLLMMetrics: mockRecordLLMMetrics,
    getLLMMetricsSummary: mock.fn(async (): Promise<LLMMetricsSummary> => ({
        summary: {
            totalRequests: 0,
            totalSuccessful: 0,
            totalFailed: 0,
            successRate: 0,
            totalCostUsd: 0,
            avgCostPerRequest: 0,
            totalTurns: 0,
            avgTurnsPerRequest: 0,
            avgExecutionTimeSec: 0
        },
        modelBreakdown: {},
        dailyMetrics: [],
        recentHighCostAlerts: [],
        lastUpdated: new Date().toISOString()
    })),
    getLLMMetricsByCorrelationId: mock.fn(async () => null)
};

// ========== Webhook Event Factory ==========
// These factory functions generate realistic GitHub webhook event payloads
// for testing webhook handlers. All factories support customization via options.

import type {
    IssuesEvent,
    IssuesLabeledEvent,
    IssuesOpenedEvent,
    IssuesClosedEvent,
    IssuesReopenedEvent,
    IssueCommentEvent,
    IssueCommentCreatedEvent,
    IssueCommentDeletedEvent,
    IssueCommentEditedEvent,
    PullRequestEvent,
    PullRequestOpenedEvent,
    PullRequestClosedEvent,
    PullRequestLabeledEvent,
    PullRequestUnlabeledEvent,
    PullRequestReviewCommentEvent,
    PullRequestReviewCommentCreatedEvent,
    PullRequestReviewCommentDeletedEvent,
    PullRequestReviewCommentEditedEvent,
    CheckRunEvent,
    User,
    Repository,
    Issue,
    Label,
    PullRequest
} from '@octokit/webhooks-types';

// ========== Common Component Factories ==========

/**
 * Options for creating a mock GitHub user.
 */
export interface CreateMockUserOptions {
    login?: string;
    id?: number;
    type?: 'User' | 'Bot' | 'Organization';
    siteAdmin?: boolean;
}

/**
 * Creates a mock GitHub user object.
 *
 * @param options - Configuration options for the user
 * @returns A complete User object matching @octokit/webhooks-types
 *
 * @example
 * const user = createMockUser({ login: 'testuser', type: 'User' });
 */
export function createMockUser(options: CreateMockUserOptions = {}): User {
    const {
        login = 'testuser',
        id = Math.floor(Math.random() * 1000000),
        type = 'User',
        siteAdmin = false
    } = options;

    return {
        login,
        id,
        node_id: `U_${id}`,
        avatar_url: `https://avatars.githubusercontent.com/u/${id}?v=4`,
        gravatar_id: '',
        url: `https://api.github.com/users/${login}`,
        html_url: `https://github.com/${login}`,
        followers_url: `https://api.github.com/users/${login}/followers`,
        following_url: `https://api.github.com/users/${login}/following{/other_user}`,
        gists_url: `https://api.github.com/users/${login}/gists{/gist_id}`,
        starred_url: `https://api.github.com/users/${login}/starred{/owner}{/repo}`,
        subscriptions_url: `https://api.github.com/users/${login}/subscriptions`,
        organizations_url: `https://api.github.com/users/${login}/orgs`,
        repos_url: `https://api.github.com/users/${login}/repos`,
        events_url: `https://api.github.com/users/${login}/events{/privacy}`,
        received_events_url: `https://api.github.com/users/${login}/received_events`,
        type,
        site_admin: siteAdmin
    };
}

/**
 * Options for creating a mock GitHub label.
 */
export interface CreateMockLabelOptions {
    id?: number;
    name?: string;
    color?: string;
    description?: string | null;
    isDefault?: boolean;
}

/**
 * Creates a mock GitHub label object.
 *
 * @param options - Configuration options for the label
 * @returns A complete Label object matching @octokit/webhooks-types
 *
 * @example
 * const label = createMockLabel({ name: 'bug', color: 'd73a4a' });
 */
export function createMockLabel(options: CreateMockLabelOptions = {}): Label {
    const {
        id = Math.floor(Math.random() * 1000000),
        name = 'enhancement',
        color = '0366d6',
        description = null,
        isDefault = false
    } = options;

    return {
        id,
        node_id: `LA_${id}`,
        url: `https://api.github.com/repos/owner/repo/labels/${encodeURIComponent(name)}`,
        name,
        color,
        default: isDefault,
        description
    };
}

/**
 * Options for creating a mock GitHub repository.
 */
export interface CreateMockRepositoryOptions {
    id?: number;
    name?: string;
    owner?: string;
    fullName?: string;
    private?: boolean;
    defaultBranch?: string;
    description?: string | null;
}

/**
 * Creates a mock GitHub repository object.
 *
 * @param options - Configuration options for the repository
 * @returns A complete Repository object matching @octokit/webhooks-types
 *
 * @example
 * const repo = createMockRepository({ owner: 'myorg', name: 'myrepo' });
 */
export function createMockRepository(options: CreateMockRepositoryOptions = {}): Repository {
    const {
        id = Math.floor(Math.random() * 1000000),
        name = 'testrepo',
        owner = 'testowner',
        fullName = `${options.owner ?? 'testowner'}/${options.name ?? 'testrepo'}`,
        private: isPrivate = false,
        defaultBranch = 'main',
        description = null
    } = options;

    const ownerUser = createMockUser({ login: owner });

    return {
        id,
        node_id: `R_${id}`,
        name,
        full_name: fullName,
        private: isPrivate,
        owner: ownerUser,
        html_url: `https://github.com/${fullName}`,
        description,
        fork: false,
        url: `https://api.github.com/repos/${fullName}`,
        forks_url: `https://api.github.com/repos/${fullName}/forks`,
        keys_url: `https://api.github.com/repos/${fullName}/keys{/key_id}`,
        collaborators_url: `https://api.github.com/repos/${fullName}/collaborators{/collaborator}`,
        teams_url: `https://api.github.com/repos/${fullName}/teams`,
        hooks_url: `https://api.github.com/repos/${fullName}/hooks`,
        issue_events_url: `https://api.github.com/repos/${fullName}/issues/events{/number}`,
        events_url: `https://api.github.com/repos/${fullName}/events`,
        assignees_url: `https://api.github.com/repos/${fullName}/assignees{/user}`,
        branches_url: `https://api.github.com/repos/${fullName}/branches{/branch}`,
        tags_url: `https://api.github.com/repos/${fullName}/tags`,
        blobs_url: `https://api.github.com/repos/${fullName}/git/blobs{/sha}`,
        git_tags_url: `https://api.github.com/repos/${fullName}/git/tags{/sha}`,
        git_refs_url: `https://api.github.com/repos/${fullName}/git/refs{/sha}`,
        trees_url: `https://api.github.com/repos/${fullName}/git/trees{/sha}`,
        statuses_url: `https://api.github.com/repos/${fullName}/statuses/{sha}`,
        languages_url: `https://api.github.com/repos/${fullName}/languages`,
        stargazers_url: `https://api.github.com/repos/${fullName}/stargazers`,
        contributors_url: `https://api.github.com/repos/${fullName}/contributors`,
        subscribers_url: `https://api.github.com/repos/${fullName}/subscribers`,
        subscription_url: `https://api.github.com/repos/${fullName}/subscription`,
        commits_url: `https://api.github.com/repos/${fullName}/commits{/sha}`,
        git_commits_url: `https://api.github.com/repos/${fullName}/git/commits{/sha}`,
        comments_url: `https://api.github.com/repos/${fullName}/comments{/number}`,
        issue_comment_url: `https://api.github.com/repos/${fullName}/issues/comments{/number}`,
        contents_url: `https://api.github.com/repos/${fullName}/contents/{+path}`,
        compare_url: `https://api.github.com/repos/${fullName}/compare/{base}...{head}`,
        merges_url: `https://api.github.com/repos/${fullName}/merges`,
        archive_url: `https://api.github.com/repos/${fullName}/{archive_format}{/ref}`,
        downloads_url: `https://api.github.com/repos/${fullName}/downloads`,
        issues_url: `https://api.github.com/repos/${fullName}/issues{/number}`,
        pulls_url: `https://api.github.com/repos/${fullName}/pulls{/number}`,
        milestones_url: `https://api.github.com/repos/${fullName}/milestones{/number}`,
        notifications_url: `https://api.github.com/repos/${fullName}/notifications{?since,all,participating}`,
        labels_url: `https://api.github.com/repos/${fullName}/labels{/name}`,
        releases_url: `https://api.github.com/repos/${fullName}/releases{/id}`,
        deployments_url: `https://api.github.com/repos/${fullName}/deployments`,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        pushed_at: new Date().toISOString(),
        git_url: `git://github.com/${fullName}.git`,
        ssh_url: `git@github.com:${fullName}.git`,
        clone_url: `https://github.com/${fullName}.git`,
        svn_url: `https://github.com/${fullName}`,
        homepage: null,
        size: 0,
        stargazers_count: 0,
        watchers_count: 0,
        language: 'TypeScript',
        has_issues: true,
        has_projects: true,
        has_downloads: true,
        has_wiki: true,
        has_pages: false,
        has_discussions: false,
        forks_count: 0,
        mirror_url: null,
        archived: false,
        disabled: false,
        open_issues_count: 0,
        license: null,
        allow_forking: true,
        is_template: false,
        web_commit_signoff_required: false,
        topics: [],
        visibility: isPrivate ? 'private' : 'public',
        forks: 0,
        open_issues: 0,
        watchers: 0,
        default_branch: defaultBranch
    } as Repository;
}

/**
 * Options for creating a mock GitHub issue.
 */
export interface CreateMockIssueOptions {
    id?: number;
    number?: number;
    title?: string;
    body?: string | null;
    state?: 'open' | 'closed';
    labels?: Array<string | CreateMockLabelOptions>;
    user?: CreateMockUserOptions;
    repository?: CreateMockRepositoryOptions;
    locked?: boolean;
    assignees?: CreateMockUserOptions[];
}

/**
 * Creates a mock GitHub issue object.
 *
 * @param options - Configuration options for the issue
 * @returns A complete Issue object matching @octokit/webhooks-types
 *
 * @example
 * const issue = createMockIssue({
 *     number: 42,
 *     title: 'Bug report',
 *     labels: ['bug', { name: 'AI', color: 'ff0000' }]
 * });
 */
export function createMockIssue(options: CreateMockIssueOptions = {}): Issue {
    const {
        id = Math.floor(Math.random() * 1000000),
        number = Math.floor(Math.random() * 10000),
        title = `Test Issue #${options.number ?? Math.floor(Math.random() * 10000)}`,
        body = 'Test issue body',
        state = 'open',
        labels = [],
        user = {},
        repository = {},
        locked = false,
        assignees = []
    } = options;

    const repo = createMockRepository(repository);
    const issueUser = createMockUser(user);
    const issueLabels = labels.map(label =>
        typeof label === 'string' ? createMockLabel({ name: label }) : createMockLabel(label)
    );

    return {
        id,
        node_id: `I_${id}`,
        url: `https://api.github.com/repos/${repo.full_name}/issues/${number}`,
        repository_url: `https://api.github.com/repos/${repo.full_name}`,
        labels_url: `https://api.github.com/repos/${repo.full_name}/issues/${number}/labels{/name}`,
        comments_url: `https://api.github.com/repos/${repo.full_name}/issues/${number}/comments`,
        events_url: `https://api.github.com/repos/${repo.full_name}/issues/${number}/events`,
        html_url: `https://github.com/${repo.full_name}/issues/${number}`,
        number,
        state,
        state_reason: null,
        title,
        body,
        user: issueUser,
        labels: issueLabels,
        assignee: assignees.length > 0 ? createMockUser(assignees[0]) : null,
        assignees: assignees.map(a => createMockUser(a)),
        milestone: null,
        locked,
        active_lock_reason: null,
        comments: 0,
        pull_request: undefined,
        closed_at: state === 'closed' ? new Date().toISOString() : null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        author_association: 'OWNER',
        reactions: {
            url: `https://api.github.com/repos/${repo.full_name}/issues/${number}/reactions`,
            total_count: 0,
            '+1': 0,
            '-1': 0,
            laugh: 0,
            hooray: 0,
            confused: 0,
            heart: 0,
            rocket: 0,
            eyes: 0
        },
        timeline_url: `https://api.github.com/repos/${repo.full_name}/issues/${number}/timeline`,
        performed_via_github_app: null
    } as Issue;
}

// ========== Issues Event Factory ==========

/**
 * Action types supported for issues events.
 */
export type IssuesEventAction = 'opened' | 'edited' | 'deleted' | 'pinned' | 'unpinned' |
    'closed' | 'reopened' | 'assigned' | 'unassigned' | 'labeled' | 'unlabeled' |
    'locked' | 'unlocked' | 'transferred' | 'milestoned' | 'demilestoned';

/**
 * Options for creating a mock issues webhook event.
 */
export interface CreateWebhookIssuesEventOptions {
    action?: IssuesEventAction;
    issue?: CreateMockIssueOptions;
    repository?: CreateMockRepositoryOptions;
    sender?: CreateMockUserOptions;
    /** The label that was added/removed (for labeled/unlabeled actions) */
    label?: CreateMockLabelOptions;
}

/**
 * Creates a mock GitHub issues webhook event payload.
 *
 * @param options - Configuration options for the event
 * @returns A complete IssuesEvent object matching @octokit/webhooks-types
 *
 * @example
 * // Create a labeled event
 * const event = createWebhookIssuesEvent({
 *     action: 'labeled',
 *     issue: { number: 42, labels: ['AI'] },
 *     label: { name: 'AI' }
 * });
 *
 * @example
 * // Create a closed event
 * const event = createWebhookIssuesEvent({
 *     action: 'closed',
 *     issue: { number: 42, state: 'closed' }
 * });
 */
export function createWebhookIssuesEvent(options: CreateWebhookIssuesEventOptions = {}): IssuesEvent {
    const {
        action = 'opened',
        issue = {},
        repository = {},
        sender = {},
        label
    } = options;

    const repo = createMockRepository(repository);
    const issueObj = createMockIssue({ ...issue, repository });
    const senderUser = createMockUser(sender);

    const baseEvent = {
        action,
        issue: issueObj,
        repository: repo,
        sender: senderUser
    };

    // Add label property for labeled/unlabeled actions
    if ((action === 'labeled' || action === 'unlabeled') && label) {
        return {
            ...baseEvent,
            label: createMockLabel(label)
        } as IssuesLabeledEvent;
    }

    return baseEvent as IssuesEvent;
}

/**
 * Creates a mock issues labeled event with proper typing.
 */
export function createWebhookIssuesLabeledEvent(
    options: Omit<CreateWebhookIssuesEventOptions, 'action'> & { label: CreateMockLabelOptions }
): IssuesLabeledEvent {
    return createWebhookIssuesEvent({ ...options, action: 'labeled' }) as IssuesLabeledEvent;
}

/**
 * Creates a mock issues opened event with proper typing.
 */
export function createWebhookIssuesOpenedEvent(
    options: Omit<CreateWebhookIssuesEventOptions, 'action'> = {}
): IssuesOpenedEvent {
    return createWebhookIssuesEvent({ ...options, action: 'opened' }) as IssuesOpenedEvent;
}

/**
 * Creates a mock issues closed event with proper typing.
 */
export function createWebhookIssuesClosedEvent(
    options: Omit<CreateWebhookIssuesEventOptions, 'action'> = {}
): IssuesClosedEvent {
    return createWebhookIssuesEvent({
        ...options,
        action: 'closed',
        issue: { ...options.issue, state: 'closed' }
    }) as IssuesClosedEvent;
}

/**
 * Creates a mock issues reopened event with proper typing.
 */
export function createWebhookIssuesReopenedEvent(
    options: Omit<CreateWebhookIssuesEventOptions, 'action'> = {}
): IssuesReopenedEvent {
    return createWebhookIssuesEvent({
        ...options,
        action: 'reopened',
        issue: { ...options.issue, state: 'open' }
    }) as IssuesReopenedEvent;
}

// ========== Issue Comment Event Factory ==========

/**
 * Options for creating a mock issue comment.
 */
export interface CreateMockIssueCommentOptions {
    id?: number;
    body?: string;
    user?: CreateMockUserOptions;
    issueNumber?: number;
    repository?: CreateMockRepositoryOptions;
}

/**
 * Creates a mock issue comment object.
 */
function createMockIssueComment(options: CreateMockIssueCommentOptions = {}) {
    const {
        id = Math.floor(Math.random() * 1000000),
        body = 'Test comment body',
        user = {},
        issueNumber = 1,
        repository = {}
    } = options;

    const repo = createMockRepository(repository);
    const commentUser = createMockUser(user);

    return {
        id,
        node_id: `IC_${id}`,
        url: `https://api.github.com/repos/${repo.full_name}/issues/comments/${id}`,
        html_url: `https://github.com/${repo.full_name}/issues/${issueNumber}#issuecomment-${id}`,
        body,
        user: commentUser,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        issue_url: `https://api.github.com/repos/${repo.full_name}/issues/${issueNumber}`,
        author_association: 'OWNER' as const,
        performed_via_github_app: null,
        reactions: {
            url: `https://api.github.com/repos/${repo.full_name}/issues/comments/${id}/reactions`,
            total_count: 0,
            '+1': 0,
            '-1': 0,
            laugh: 0,
            hooray: 0,
            confused: 0,
            heart: 0,
            rocket: 0,
            eyes: 0
        }
    };
}

/**
 * Action types supported for issue comment events.
 */
export type IssueCommentEventAction = 'created' | 'edited' | 'deleted';

/**
 * Options for creating a mock issue comment webhook event.
 */
export interface CreateWebhookIssueCommentEventOptions {
    action?: IssueCommentEventAction;
    comment?: CreateMockIssueCommentOptions;
    issue?: CreateMockIssueOptions;
    repository?: CreateMockRepositoryOptions;
    sender?: CreateMockUserOptions;
}

/**
 * Creates a mock GitHub issue comment webhook event payload.
 *
 * @param options - Configuration options for the event
 * @returns A complete IssueCommentEvent object matching @octokit/webhooks-types
 *
 * @example
 * const event = createWebhookIssueCommentEvent({
 *     action: 'created',
 *     comment: { body: '/propr fix this bug' },
 *     issue: { number: 42 }
 * });
 */
export function createWebhookIssueCommentEvent(options: CreateWebhookIssueCommentEventOptions = {}): IssueCommentEvent {
    const {
        action = 'created',
        comment = {},
        issue = {},
        repository = {},
        sender = {}
    } = options;

    const repo = createMockRepository(repository);
    const issueObj = createMockIssue({ ...issue, repository });
    const commentObj = createMockIssueComment({
        ...comment,
        issueNumber: issueObj.number,
        repository
    });
    const senderUser = createMockUser(sender);

    return {
        action,
        comment: commentObj,
        issue: issueObj,
        repository: repo,
        sender: senderUser
    } as IssueCommentEvent;
}

/**
 * Creates a mock issue comment created event with proper typing.
 */
export function createWebhookIssueCommentCreatedEvent(
    options: Omit<CreateWebhookIssueCommentEventOptions, 'action'> = {}
): IssueCommentCreatedEvent {
    return createWebhookIssueCommentEvent({ ...options, action: 'created' }) as IssueCommentCreatedEvent;
}

/**
 * Creates a mock issue comment deleted event with proper typing.
 */
export function createWebhookIssueCommentDeletedEvent(
    options: Omit<CreateWebhookIssueCommentEventOptions, 'action'> = {}
): IssueCommentDeletedEvent {
    return createWebhookIssueCommentEvent({ ...options, action: 'deleted' }) as IssueCommentDeletedEvent;
}

/**
 * Creates a mock issue comment edited event with proper typing.
 */
export function createWebhookIssueCommentEditedEvent(
    options: Omit<CreateWebhookIssueCommentEventOptions, 'action'> = {}
): IssueCommentEditedEvent {
    return createWebhookIssueCommentEvent({ ...options, action: 'edited' }) as IssueCommentEditedEvent;
}

// ========== Pull Request Event Factory ==========

/**
 * Options for creating a mock pull request.
 */
export interface CreateMockPullRequestOptions {
    id?: number;
    number?: number;
    title?: string;
    body?: string | null;
    state?: 'open' | 'closed';
    draft?: boolean;
    merged?: boolean;
    labels?: Array<string | CreateMockLabelOptions>;
    user?: CreateMockUserOptions;
    repository?: CreateMockRepositoryOptions;
    headRef?: string;
    headSha?: string;
    baseRef?: string;
    baseSha?: string;
    /** Owner of the head repository (for fork detection) */
    headRepoOwner?: string;
}

/**
 * Creates a mock GitHub pull request object.
 *
 * @param options - Configuration options for the pull request
 * @returns A complete PullRequest object matching @octokit/webhooks-types
 *
 * @example
 * const pr = createMockPullRequest({
 *     number: 123,
 *     title: 'Add new feature',
 *     labels: ['auto-merge'],
 *     headRef: 'feature-branch'
 * });
 */
export function createMockPullRequest(options: CreateMockPullRequestOptions = {}): PullRequest {
    const {
        id = Math.floor(Math.random() * 1000000),
        number = Math.floor(Math.random() * 10000),
        title = `Test PR #${options.number ?? Math.floor(Math.random() * 10000)}`,
        body = 'Test pull request body',
        state = 'open',
        draft = false,
        merged = false,
        labels = [],
        user = {},
        repository = {},
        headRef = 'feature-branch',
        headSha = `sha${Math.random().toString(36).substring(2, 10)}`,
        baseRef = 'main',
        baseSha = `sha${Math.random().toString(36).substring(2, 10)}`,
        headRepoOwner
    } = options;

    const repo = createMockRepository(repository);
    const prUser = createMockUser(user);
    const prLabels = labels.map(label =>
        typeof label === 'string' ? createMockLabel({ name: label }) : createMockLabel(label)
    );

    // Determine head repo owner (same as base unless forked)
    const headOwner = headRepoOwner ?? repo.owner.login;
    const headRepo = createMockRepository({
        ...repository,
        owner: headOwner,
        fullName: `${headOwner}/${repo.name}`
    });

    return {
        id,
        node_id: `PR_${id}`,
        url: `https://api.github.com/repos/${repo.full_name}/pulls/${number}`,
        html_url: `https://github.com/${repo.full_name}/pull/${number}`,
        diff_url: `https://github.com/${repo.full_name}/pull/${number}.diff`,
        patch_url: `https://github.com/${repo.full_name}/pull/${number}.patch`,
        issue_url: `https://api.github.com/repos/${repo.full_name}/issues/${number}`,
        number,
        state,
        locked: false,
        title,
        body,
        user: prUser,
        labels: prLabels,
        milestone: null,
        active_lock_reason: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        closed_at: state === 'closed' ? new Date().toISOString() : null,
        merged_at: merged ? new Date().toISOString() : null,
        merge_commit_sha: merged ? `merge${Math.random().toString(36).substring(2, 10)}` : null,
        assignee: null,
        assignees: [],
        requested_reviewers: [],
        requested_teams: [],
        head: {
            label: `${headOwner}:${headRef}`,
            ref: headRef,
            sha: headSha,
            user: createMockUser({ login: headOwner }),
            repo: headRepo
        },
        base: {
            label: `${repo.owner.login}:${baseRef}`,
            ref: baseRef,
            sha: baseSha,
            user: repo.owner,
            repo: repo
        },
        _links: {
            self: { href: `https://api.github.com/repos/${repo.full_name}/pulls/${number}` },
            html: { href: `https://github.com/${repo.full_name}/pull/${number}` },
            issue: { href: `https://api.github.com/repos/${repo.full_name}/issues/${number}` },
            comments: { href: `https://api.github.com/repos/${repo.full_name}/issues/${number}/comments` },
            review_comments: { href: `https://api.github.com/repos/${repo.full_name}/pulls/${number}/comments` },
            review_comment: { href: `https://api.github.com/repos/${repo.full_name}/pulls/comments{/number}` },
            commits: { href: `https://api.github.com/repos/${repo.full_name}/pulls/${number}/commits` },
            statuses: { href: `https://api.github.com/repos/${repo.full_name}/statuses/${headSha}` }
        },
        author_association: 'OWNER',
        auto_merge: null,
        draft,
        merged,
        mergeable: !merged && state === 'open',
        rebaseable: true,
        mergeable_state: merged ? 'unknown' : 'clean',
        merged_by: merged ? prUser : null,
        comments: 0,
        review_comments: 0,
        maintainer_can_modify: true,
        commits: 1,
        additions: 10,
        deletions: 5,
        changed_files: 2
    } as unknown as PullRequest;
}

/**
 * Action types supported for pull request events.
 */
export type PullRequestEventAction = 'opened' | 'edited' | 'closed' | 'reopened' |
    'assigned' | 'unassigned' | 'review_requested' | 'review_request_removed' |
    'labeled' | 'unlabeled' | 'synchronize' | 'converted_to_draft' | 'ready_for_review' |
    'locked' | 'unlocked' | 'auto_merge_enabled' | 'auto_merge_disabled';

/**
 * Options for creating a mock pull request webhook event.
 */
export interface CreateWebhookPullRequestEventOptions {
    action?: PullRequestEventAction;
    pullRequest?: CreateMockPullRequestOptions;
    repository?: CreateMockRepositoryOptions;
    sender?: CreateMockUserOptions;
    /** The label that was added/removed (for labeled/unlabeled actions) */
    label?: CreateMockLabelOptions;
}

/**
 * Creates a mock GitHub pull request webhook event payload.
 *
 * @param options - Configuration options for the event
 * @returns A complete PullRequestEvent object matching @octokit/webhooks-types
 *
 * @example
 * const event = createWebhookPullRequestEvent({
 *     action: 'labeled',
 *     pullRequest: { number: 123, labels: ['auto-merge'] },
 *     label: { name: 'auto-merge' }
 * });
 */
export function createWebhookPullRequestEvent(options: CreateWebhookPullRequestEventOptions = {}): PullRequestEvent {
    const {
        action = 'opened',
        pullRequest = {},
        repository = {},
        sender = {},
        label
    } = options;

    const repo = createMockRepository(repository);
    const prObj = createMockPullRequest({ ...pullRequest, repository });
    const senderUser = createMockUser(sender);

    const baseEvent = {
        action,
        number: prObj.number,
        pull_request: prObj,
        repository: repo,
        sender: senderUser
    };

    // Add label property for labeled/unlabeled actions
    if ((action === 'labeled' || action === 'unlabeled') && label) {
        return {
            ...baseEvent,
            label: createMockLabel(label)
        } as PullRequestLabeledEvent;
    }

    return baseEvent as PullRequestEvent;
}

/**
 * Creates a mock pull request labeled event with proper typing.
 */
export function createWebhookPullRequestLabeledEvent(
    options: Omit<CreateWebhookPullRequestEventOptions, 'action'> & { label: CreateMockLabelOptions }
): PullRequestLabeledEvent {
    return createWebhookPullRequestEvent({ ...options, action: 'labeled' }) as PullRequestLabeledEvent;
}

/**
 * Creates a mock pull request unlabeled event with proper typing.
 */
export function createWebhookPullRequestUnlabeledEvent(
    options: Omit<CreateWebhookPullRequestEventOptions, 'action'> & { label: CreateMockLabelOptions }
): PullRequestUnlabeledEvent {
    return createWebhookPullRequestEvent({ ...options, action: 'unlabeled' }) as PullRequestUnlabeledEvent;
}

/**
 * Creates a mock pull request opened event with proper typing.
 */
export function createWebhookPullRequestOpenedEvent(
    options: Omit<CreateWebhookPullRequestEventOptions, 'action'> = {}
): PullRequestOpenedEvent {
    return createWebhookPullRequestEvent({ ...options, action: 'opened' }) as PullRequestOpenedEvent;
}

/**
 * Creates a mock pull request closed event with proper typing.
 */
export function createWebhookPullRequestClosedEvent(
    options: Omit<CreateWebhookPullRequestEventOptions, 'action'> = {}
): PullRequestClosedEvent {
    return createWebhookPullRequestEvent({
        ...options,
        action: 'closed',
        pullRequest: { ...options.pullRequest, state: 'closed' }
    }) as PullRequestClosedEvent;
}

// ========== Pull Request Review Comment Event Factory ==========

/**
 * Options for creating a mock pull request review comment.
 */
export interface CreateMockPRReviewCommentOptions {
    id?: number;
    body?: string;
    user?: CreateMockUserOptions;
    pullRequestNumber?: number;
    repository?: CreateMockRepositoryOptions;
    path?: string;
    line?: number;
    commitId?: string;
}

/**
 * Creates a mock pull request review comment object.
 */
function createMockPRReviewComment(options: CreateMockPRReviewCommentOptions = {}) {
    const {
        id = Math.floor(Math.random() * 1000000),
        body = 'Test review comment body',
        user = {},
        pullRequestNumber = 1,
        repository = {},
        path = 'src/index.ts',
        line = 10,
        commitId = `sha${Math.random().toString(36).substring(2, 10)}`
    } = options;

    const repo = createMockRepository(repository);
    const commentUser = createMockUser(user);

    return {
        id,
        node_id: `PRRC_${id}`,
        url: `https://api.github.com/repos/${repo.full_name}/pulls/comments/${id}`,
        html_url: `https://github.com/${repo.full_name}/pull/${pullRequestNumber}#discussion_r${id}`,
        body,
        user: commentUser,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        pull_request_review_id: Math.floor(Math.random() * 1000000),
        diff_hunk: '@@ -1,5 +1,10 @@',
        path,
        position: null,
        original_position: line,
        commit_id: commitId,
        original_commit_id: commitId,
        pull_request_url: `https://api.github.com/repos/${repo.full_name}/pulls/${pullRequestNumber}`,
        author_association: 'OWNER' as const,
        _links: {
            self: { href: `https://api.github.com/repos/${repo.full_name}/pulls/comments/${id}` },
            html: { href: `https://github.com/${repo.full_name}/pull/${pullRequestNumber}#discussion_r${id}` },
            pull_request: { href: `https://api.github.com/repos/${repo.full_name}/pulls/${pullRequestNumber}` }
        },
        start_line: null,
        original_start_line: null,
        start_side: null,
        line,
        original_line: line,
        side: 'RIGHT' as const,
        in_reply_to_id: undefined,
        subject_type: 'line' as const,
        reactions: {
            url: `https://api.github.com/repos/${repo.full_name}/pulls/comments/${id}/reactions`,
            total_count: 0,
            '+1': 0,
            '-1': 0,
            laugh: 0,
            hooray: 0,
            confused: 0,
            heart: 0,
            rocket: 0,
            eyes: 0
        }
    };
}

/**
 * Action types supported for pull request review comment events.
 */
export type PullRequestReviewCommentEventAction = 'created' | 'edited' | 'deleted';

/**
 * Options for creating a mock pull request review comment webhook event.
 */
export interface CreateWebhookPRReviewCommentEventOptions {
    action?: PullRequestReviewCommentEventAction;
    comment?: CreateMockPRReviewCommentOptions;
    pullRequest?: CreateMockPullRequestOptions;
    repository?: CreateMockRepositoryOptions;
    sender?: CreateMockUserOptions;
}

/**
 * Creates a mock GitHub pull request review comment webhook event payload.
 *
 * @param options - Configuration options for the event
 * @returns A complete PullRequestReviewCommentEvent object matching @octokit/webhooks-types
 *
 * @example
 * const event = createWebhookPRReviewCommentEvent({
 *     action: 'created',
 *     comment: { body: 'Please fix this' },
 *     pullRequest: { number: 123 }
 * });
 */
export function createWebhookPRReviewCommentEvent(
    options: CreateWebhookPRReviewCommentEventOptions = {}
): PullRequestReviewCommentEvent {
    const {
        action = 'created',
        comment = {},
        pullRequest = {},
        repository = {},
        sender = {}
    } = options;

    const repo = createMockRepository(repository);
    const prObj = createMockPullRequest({ ...pullRequest, repository });
    const commentObj = createMockPRReviewComment({
        ...comment,
        pullRequestNumber: prObj.number,
        repository
    });
    const senderUser = createMockUser(sender);

    return {
        action,
        comment: commentObj,
        pull_request: prObj,
        repository: repo,
        sender: senderUser
    } as PullRequestReviewCommentEvent;
}

/**
 * Creates a mock PR review comment created event with proper typing.
 */
export function createWebhookPRReviewCommentCreatedEvent(
    options: Omit<CreateWebhookPRReviewCommentEventOptions, 'action'> = {}
): PullRequestReviewCommentCreatedEvent {
    return createWebhookPRReviewCommentEvent({ ...options, action: 'created' }) as PullRequestReviewCommentCreatedEvent;
}

/**
 * Creates a mock PR review comment deleted event with proper typing.
 */
export function createWebhookPRReviewCommentDeletedEvent(
    options: Omit<CreateWebhookPRReviewCommentEventOptions, 'action'> = {}
): PullRequestReviewCommentDeletedEvent {
    return createWebhookPRReviewCommentEvent({ ...options, action: 'deleted' }) as PullRequestReviewCommentDeletedEvent;
}

/**
 * Creates a mock PR review comment edited event with proper typing.
 */
export function createWebhookPRReviewCommentEditedEvent(
    options: Omit<CreateWebhookPRReviewCommentEventOptions, 'action'> = {}
): PullRequestReviewCommentEditedEvent {
    return createWebhookPRReviewCommentEvent({ ...options, action: 'edited' }) as PullRequestReviewCommentEditedEvent;
}

// ========== Check Run Event Factory ==========

/**
 * Action types supported for check run events.
 */
export type CheckRunEventAction = 'created' | 'completed' | 'rerequested' | 'requested_action';

/**
 * Conclusion values for completed check runs.
 */
export type CheckRunConclusion = 'success' | 'failure' | 'neutral' | 'cancelled' |
    'skipped' | 'timed_out' | 'action_required' | 'stale' | null;

/**
 * Options for creating a mock check run webhook event.
 */
export interface CreateWebhookCheckRunEventOptions {
    action?: CheckRunEventAction;
    conclusion?: CheckRunConclusion;
    status?: 'queued' | 'in_progress' | 'completed';
    checkRunName?: string;
    headSha?: string;
    pullRequests?: Array<{ number: number }>;
    repository?: CreateMockRepositoryOptions;
    sender?: CreateMockUserOptions;
}

/**
 * Creates a mock GitHub check run webhook event payload.
 *
 * @param options - Configuration options for the event
 * @returns A complete CheckRunEvent object matching @octokit/webhooks-types
 *
 * @example
 * // Create a successful check run completion
 * const event = createWebhookCheckRunEvent({
 *     action: 'completed',
 *     conclusion: 'success',
 *     pullRequests: [{ number: 42 }]
 * });
 *
 * @example
 * // Create a failed check run
 * const event = createWebhookCheckRunEvent({
 *     action: 'completed',
 *     conclusion: 'failure',
 *     checkRunName: 'CI Tests'
 * });
 */
export function createWebhookCheckRunEvent(options: CreateWebhookCheckRunEventOptions = {}): CheckRunEvent {
    const {
        action = 'completed',
        conclusion = 'success',
        status = 'completed',
        checkRunName = 'CI Tests',
        headSha = `sha${Math.random().toString(36).substring(2, 10)}`,
        pullRequests = [{ number: 1 }],
        repository = {},
        sender = { login: 'github-actions', type: 'Bot' }
    } = options;

    const repo = createMockRepository(repository);
    const senderUser = createMockUser(sender);
    const checkRunId = Math.floor(Math.random() * 1000000);

    return {
        action,
        check_run: {
            id: checkRunId,
            name: checkRunName,
            node_id: `CR_${checkRunId}`,
            head_sha: headSha,
            external_id: '',
            url: `https://api.github.com/repos/${repo.full_name}/check-runs/${checkRunId}`,
            html_url: `https://github.com/${repo.full_name}/runs/${checkRunId}`,
            details_url: null,
            status,
            conclusion: status === 'completed' ? conclusion : null,
            started_at: new Date().toISOString(),
            completed_at: status === 'completed' ? new Date().toISOString() : null,
            output: {
                title: null,
                summary: null,
                text: null,
                annotations_count: 0,
                annotations_url: `https://api.github.com/repos/${repo.full_name}/check-runs/${checkRunId}/annotations`
            },
            check_suite: {
                id: Math.floor(Math.random() * 1000000),
                node_id: `CS_${Math.floor(Math.random() * 1000000)}`,
                head_branch: 'main',
                head_sha: headSha,
                status: 'completed',
                conclusion,
                url: `https://api.github.com/repos/${repo.full_name}/check-suites/${Math.floor(Math.random() * 1000000)}`,
                before: null,
                after: null,
                pull_requests: pullRequests.map(pr => ({
                    id: pr.number * 1000,
                    number: pr.number,
                    url: `https://api.github.com/repos/${repo.full_name}/pulls/${pr.number}`,
                    head: { sha: headSha, ref: 'feature-branch' },
                    base: { sha: `base${Math.random().toString(36).substring(2, 10)}`, ref: 'main' }
                })),
                app: {
                    id: 1,
                    slug: 'github-actions',
                    node_id: 'A_1',
                    owner: senderUser,
                    name: 'GitHub Actions',
                    description: '',
                    external_url: 'https://github.com/features/actions',
                    html_url: 'https://github.com/apps/github-actions',
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString(),
                    permissions: {},
                    events: []
                },
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            },
            app: {
                id: 1,
                slug: 'github-actions',
                node_id: 'A_1',
                owner: senderUser,
                name: 'GitHub Actions',
                description: '',
                external_url: 'https://github.com/features/actions',
                html_url: 'https://github.com/apps/github-actions',
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
                permissions: {},
                events: []
            },
            pull_requests: pullRequests.map(pr => ({
                id: pr.number * 1000,
                number: pr.number,
                url: `https://api.github.com/repos/${repo.full_name}/pulls/${pr.number}`,
                head: { sha: headSha, ref: 'feature-branch' },
                base: { sha: `base${Math.random().toString(36).substring(2, 10)}`, ref: 'main' }
            }))
        },
        repository: repo,
        sender: senderUser
    } as CheckRunEvent;
}
