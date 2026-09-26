import { test, mock, before, after } from 'node:test';
import assert from 'node:assert';
import { closeConnection, fetchIssuesForRepo, loadPrimaryProcessingLabelsFromConfig } from '@propr/core';

// fetchIssuesForRepo pulls open issues from the GitHub REST API by primary
// processing label (via octokit.paginate), drops pull requests and any issue
// carrying a `<label>-processing` / `<label>-done` exclusion label, and maps the
// survivors to DetectedIssue records tagged `source: 'polling'`.
//
// These tests drive that path with a mocked octokit — no network, no DB. The
// primary processing labels come from PRIMARY_PROCESSING_LABELS, loaded into the
// core config module via loadPrimaryProcessingLabelsFromConfig() in `before`.

process.env.PRIMARY_PROCESSING_LABELS = 'AI';
process.env.GITHUB_USER_WHITELIST = '';
delete process.env.CONFIG_REPO;

const CORRELATION_ID = 'test-correlation-id';

interface MockIssue {
    id: number;
    number: number;
    title: string;
    html_url: string;
    labels: { name: string }[];
    created_at: string;
    updated_at: string;
    user?: { id: number; login: string };
    pull_request?: unknown;
}

type PaginateFn = (endpoint: string, options: Record<string, unknown>) => Promise<unknown>;
type RequestFn = (endpoint: string, options: Record<string, unknown>) => Promise<unknown>;

/** Build a minimal octokit for issue listing and trigger-actor resolution. */
function makeOctokit(
    paginate: PaginateFn,
    request: RequestFn = async () => ({ data: [], headers: {} }),
) {
    return { paginate: mock.fn(paginate), request: mock.fn(request) } as never;
}

before(async () => {
    // Populate the core config module's primaryProcessingLabels from the env var
    // set above; without this the label loop is empty and nothing is fetched.
    await loadPrimaryProcessingLabelsFromConfig();
});

after(async () => {
    await closeConnection();
});

test('fetchIssuesForRepo handles invalid repository format', async () => {
    const octokit = makeOctokit(async () => []);
    const issues = await fetchIssuesForRepo(octokit, 'invalid-format', CORRELATION_ID);
    assert.deepStrictEqual(issues, []);
});

test('fetchIssuesForRepo queries the issues API by primary label with exclusions', async () => {
    let capturedEndpoint = '';
    let capturedOptions: Record<string, unknown> = {};
    const octokit = makeOctokit(async (endpoint, options) => {
        capturedEndpoint = endpoint;
        capturedOptions = options;
        return [];
    });

    await fetchIssuesForRepo(octokit, 'owner/repo', CORRELATION_ID);

    // One primary label ('AI') → exactly one paginated query.
    const paginate = (octokit as unknown as { paginate: ReturnType<typeof mock.fn> }).paginate;
    assert.strictEqual(paginate.mock.calls.length, 1);
    assert.strictEqual(capturedEndpoint, 'GET /repos/{owner}/{repo}/issues');
    assert.deepStrictEqual(capturedOptions, {
        owner: 'owner',
        repo: 'repo',
        state: 'open',
        labels: 'AI',
        per_page: 100,
        sort: 'created',
        direction: 'desc',
    });
});

test('fetchIssuesForRepo assigns polling ownership to the label applier, not the issue author', async () => {
    const mockIssue: MockIssue = {
        id: 123,
        number: 1,
        title: 'Test Issue',
        html_url: 'https://github.com/owner/repo/issues/1',
        labels: [{ name: 'AI' }, { name: 'bug' }],
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-02T00:00:00Z',
        user: { id: 583231, login: 'issue-author' },
    };
    const octokit = makeOctokit(
        async () => [mockIssue],
        async () => ({
            data: [{
                event: 'labeled',
                label: { name: 'AI' },
                actor: { id: 991188, login: 'label-applier' },
            }],
            headers: {},
        }),
    );

    const issues = await fetchIssuesForRepo(octokit, 'owner/repo', CORRELATION_ID);

    assert.strictEqual(issues.length, 1);
    assert.deepStrictEqual(issues[0], {
        id: 123,
        number: 1,
        title: 'Test Issue',
        url: 'https://github.com/owner/repo/issues/1',
        repoOwner: 'owner',
        repoName: 'repo',
        labels: ['AI', 'bug'],
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-02T00:00:00Z',
        triggeredBy: 'label-applier',
        triggeredById: '991188',
        source: 'polling',
    });
});

test('fetchIssuesForRepo keeps unowned polling issues when no whitelist is configured', async () => {
    const mockIssue: MockIssue = {
        id: 124,
        number: 2,
        title: 'Issue with unresolved label applier',
        html_url: 'https://github.com/owner/repo/issues/2',
        labels: [{ name: 'AI' }],
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-03T00:00:00Z',
        user: { id: 583231, login: 'issue-author' },
    };
    const octokit = makeOctokit(async () => [mockIssue]);

    const issues = await fetchIssuesForRepo(octokit, 'owner/repo', CORRELATION_ID);

    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0].number, 2);
    assert.strictEqual(issues[0].triggeredBy, 'issue-author');
    assert.ok(!('triggeredById' in issues[0]));
});

test('fetchIssuesForRepo drops issues with unresolved label appliers when a whitelist is configured', async () => {
    const previousWhitelist = process.env.GITHUB_USER_WHITELIST;
    process.env.GITHUB_USER_WHITELIST = 'allowed-user';
    try {
        const mockIssue: MockIssue = {
            id: 125,
            number: 3,
            title: 'Issue requiring an authorized label applier',
            html_url: 'https://github.com/owner/repo/issues/3',
            labels: [{ name: 'AI' }],
            created_at: '2024-01-01T00:00:00Z',
            updated_at: '2024-01-04T00:00:00Z',
            user: { id: 583231, login: 'allowed-user' },
        };
        const octokit = makeOctokit(async () => [mockIssue]);

        const issues = await fetchIssuesForRepo(octokit, 'owner/repo', CORRELATION_ID);

        assert.deepStrictEqual(issues, []);
    } finally {
        if (previousWhitelist === undefined) {
            delete process.env.GITHUB_USER_WHITELIST;
        } else {
            process.env.GITHUB_USER_WHITELIST = previousWhitelist;
        }
    }
});

test('fetchIssuesForRepo excludes pull requests and -processing/-done labels', async () => {
    const base = {
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-02T00:00:00Z',
        user: { id: 583231, login: 'octocat' },
    };
    const items: MockIssue[] = [
        // A pull request surfaced by the issues endpoint — must be dropped.
        { ...base, id: 1, number: 1, title: 'PR', html_url: 'u/1', labels: [{ name: 'AI' }], pull_request: {} },
        // Already being processed — excluded by the AI-processing label.
        { ...base, id: 2, number: 2, title: 'In progress', html_url: 'u/2', labels: [{ name: 'AI' }, { name: 'AI-processing' }] },
        // Already done — excluded by the AI-done label.
        { ...base, id: 3, number: 3, title: 'Done', html_url: 'u/3', labels: [{ name: 'AI' }, { name: 'AI-done' }] },
        // The only one that should be returned.
        { ...base, id: 4, number: 4, title: 'Fresh', html_url: 'u/4', labels: [{ name: 'AI' }] },
    ];
    const octokit = makeOctokit(
        async () => items,
        async () => ({
            data: [{
                event: 'labeled',
                label: { name: 'AI' },
                actor: { id: 991188, login: 'label-applier' },
            }],
            headers: {},
        }),
    );

    const issues = await fetchIssuesForRepo(octokit, 'owner/repo', CORRELATION_ID);

    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0].number, 4);
    assert.strictEqual(issues[0].title, 'Fresh');
});

test('fetchIssuesForRepo returns [] gracefully on API error', async () => {
    // A 404 is not in the retryable set, so this fails fast (no backoff delay)
    // and exercises the catch → return [] path.
    const octokit = makeOctokit(async () => {
        const error = new Error('Not Found') as Error & { status: number };
        error.status = 404;
        throw error;
    });

    const issues = await fetchIssuesForRepo(octokit, 'owner/repo', CORRELATION_ID);
    assert.deepStrictEqual(issues, []);
});

test('fetchIssuesForRepo is exported from @propr/core', () => {
    assert.strictEqual(typeof fetchIssuesForRepo, 'function');
});
