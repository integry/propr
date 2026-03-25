import { test, describe } from 'node:test';
import assert from 'node:assert';
import type {
    IssuesLabeledEvent,
    IssuesClosedEvent,
    IssueCommentCreatedEvent,
    PullRequestLabeledEvent,
    PullRequestReviewCommentCreatedEvent,
    CheckRunEvent
} from '@octokit/webhooks-types';
import {
    // Component factories
    createMockUser,
    createMockLabel,
    createMockRepository,
    createMockIssue,
    createMockPullRequest,
    // Issues event factories
    createWebhookIssuesEvent,
    createWebhookIssuesLabeledEvent,
    createWebhookIssuesOpenedEvent,
    createWebhookIssuesClosedEvent,
    createWebhookIssuesReopenedEvent,
    // Issue comment event factories
    createWebhookIssueCommentEvent,
    createWebhookIssueCommentCreatedEvent,
    createWebhookIssueCommentDeletedEvent,
    createWebhookIssueCommentEditedEvent,
    // Pull request event factories
    createWebhookPullRequestEvent,
    createWebhookPullRequestLabeledEvent,
    createWebhookPullRequestUnlabeledEvent,
    createWebhookPullRequestOpenedEvent,
    createWebhookPullRequestClosedEvent,
    // PR review comment event factories
    createWebhookPRReviewCommentEvent,
    createWebhookPRReviewCommentCreatedEvent,
    createWebhookPRReviewCommentDeletedEvent,
    createWebhookPRReviewCommentEditedEvent,
    // Check run event factory
    createWebhookCheckRunEvent
} from './testHelpers.js';

// ========== Component Factory Tests ==========

describe('createMockUser', () => {
    test('creates user with default values', () => {
        const user = createMockUser();
        assert.strictEqual(user.login, 'testuser');
        assert.strictEqual(user.type, 'User');
        assert.strictEqual(user.site_admin, false);
        assert.ok(user.id);
        assert.ok(user.html_url.includes(user.login));
    });

    test('creates user with custom values', () => {
        const user = createMockUser({
            login: 'customuser',
            id: 12345,
            type: 'Bot',
            siteAdmin: true
        });
        assert.strictEqual(user.login, 'customuser');
        assert.strictEqual(user.id, 12345);
        assert.strictEqual(user.type, 'Bot');
        assert.strictEqual(user.site_admin, true);
    });
});

describe('createMockLabel', () => {
    test('creates label with default values', () => {
        const label = createMockLabel();
        assert.strictEqual(label.name, 'enhancement');
        assert.strictEqual(label.color, '0366d6');
        assert.strictEqual(label.default, false);
        assert.ok(label.id);
    });

    test('creates label with custom values', () => {
        const label = createMockLabel({
            name: 'bug',
            color: 'd73a4a',
            description: 'Something is broken',
            isDefault: true
        });
        assert.strictEqual(label.name, 'bug');
        assert.strictEqual(label.color, 'd73a4a');
        assert.strictEqual(label.description, 'Something is broken');
        assert.strictEqual(label.default, true);
    });
});

describe('createMockRepository', () => {
    test('creates repository with default values', () => {
        const repo = createMockRepository();
        assert.strictEqual(repo.name, 'testrepo');
        assert.strictEqual(repo.owner.login, 'testowner');
        assert.strictEqual(repo.full_name, 'testowner/testrepo');
        assert.strictEqual(repo.default_branch, 'main');
        assert.strictEqual(repo.private, false);
    });

    test('creates repository with custom values', () => {
        const repo = createMockRepository({
            owner: 'myorg',
            name: 'myrepo',
            private: true,
            defaultBranch: 'develop'
        });
        assert.strictEqual(repo.name, 'myrepo');
        assert.strictEqual(repo.owner.login, 'myorg');
        assert.strictEqual(repo.full_name, 'myorg/myrepo');
        assert.strictEqual(repo.default_branch, 'develop');
        assert.strictEqual(repo.private, true);
    });
});

describe('createMockIssue', () => {
    test('creates issue with default values', () => {
        const issue = createMockIssue();
        assert.strictEqual(issue.state, 'open');
        assert.ok(issue.number);
        assert.ok(issue.title);
        assert.deepStrictEqual(issue.labels, []);
    });

    test('creates issue with labels as strings', () => {
        const issue = createMockIssue({
            number: 42,
            title: 'Test Issue',
            labels: ['bug', 'AI', 'auto-merge']
        });
        assert.strictEqual(issue.number, 42);
        assert.strictEqual(issue.title, 'Test Issue');
        assert.strictEqual(issue.labels.length, 3);
        assert.strictEqual(issue.labels[0].name, 'bug');
        assert.strictEqual(issue.labels[1].name, 'AI');
        assert.strictEqual(issue.labels[2].name, 'auto-merge');
    });

    test('creates issue with label objects', () => {
        const issue = createMockIssue({
            labels: [
                { name: 'bug', color: 'd73a4a' },
                { name: 'AI', color: '0366d6' }
            ]
        });
        assert.strictEqual(issue.labels[0].name, 'bug');
        assert.strictEqual(issue.labels[0].color, 'd73a4a');
        assert.strictEqual(issue.labels[1].name, 'AI');
        assert.strictEqual(issue.labels[1].color, '0366d6');
    });

    test('creates closed issue', () => {
        const issue = createMockIssue({ state: 'closed' });
        assert.strictEqual(issue.state, 'closed');
        assert.ok(issue.closed_at);
    });
});

describe('createMockPullRequest', () => {
    test('creates PR with default values', () => {
        const pr = createMockPullRequest();
        assert.strictEqual(pr.state, 'open');
        assert.strictEqual(pr.draft, false);
        assert.strictEqual(pr.merged, false);
        assert.ok(pr.number);
        assert.ok(pr.head.sha);
        assert.ok(pr.base.ref);
    });

    test('creates PR with custom values', () => {
        const pr = createMockPullRequest({
            number: 123,
            title: 'Add new feature',
            labels: ['auto-merge'],
            headRef: 'feature-branch',
            baseRef: 'main',
            draft: true
        });
        assert.strictEqual(pr.number, 123);
        assert.strictEqual(pr.title, 'Add new feature');
        assert.strictEqual(pr.labels[0].name, 'auto-merge');
        assert.strictEqual(pr.head.ref, 'feature-branch');
        assert.strictEqual(pr.base.ref, 'main');
        assert.strictEqual(pr.draft, true);
    });

    test('creates PR from fork', () => {
        const pr = createMockPullRequest({
            repository: { owner: 'mainorg', name: 'repo' },
            headRepoOwner: 'forkuser'
        });
        assert.strictEqual(pr.base.repo.owner.login, 'mainorg');
        assert.strictEqual(pr.head.repo?.owner.login, 'forkuser');
    });
});

// ========== Issues Event Factory Tests ==========

describe('createWebhookIssuesEvent', () => {
    test('creates opened event by default', () => {
        const event = createWebhookIssuesEvent();
        assert.strictEqual(event.action, 'opened');
        assert.ok(event.issue);
        assert.ok(event.repository);
        assert.ok(event.sender);
    });

    test('creates event with custom action', () => {
        const event = createWebhookIssuesEvent({ action: 'edited' });
        assert.strictEqual(event.action, 'edited');
    });
});

describe('createWebhookIssuesLabeledEvent', () => {
    test('creates labeled event with label property', () => {
        const event = createWebhookIssuesLabeledEvent({
            issue: { number: 42, labels: ['AI'] },
            label: { name: 'AI' }
        });
        assert.strictEqual(event.action, 'labeled');
        assert.strictEqual((event as IssuesLabeledEvent).label?.name, 'AI');
        assert.strictEqual(event.issue.number, 42);
    });
});

describe('createWebhookIssuesClosedEvent', () => {
    test('creates closed event with closed state', () => {
        const event = createWebhookIssuesClosedEvent({
            issue: { number: 42 }
        });
        assert.strictEqual(event.action, 'closed');
        assert.strictEqual(event.issue.state, 'closed');
    });
});

describe('createWebhookIssuesReopenedEvent', () => {
    test('creates reopened event with open state', () => {
        const event = createWebhookIssuesReopenedEvent({
            issue: { number: 42 }
        });
        assert.strictEqual(event.action, 'reopened');
        assert.strictEqual(event.issue.state, 'open');
    });
});

// ========== Issue Comment Event Factory Tests ==========

describe('createWebhookIssueCommentEvent', () => {
    test('creates created event by default', () => {
        const event = createWebhookIssueCommentEvent();
        assert.strictEqual(event.action, 'created');
        assert.ok(event.comment);
        assert.ok(event.issue);
        assert.ok(event.repository);
    });

    test('creates event with custom comment body', () => {
        const event = createWebhookIssueCommentEvent({
            comment: { body: '/propr fix this bug' },
            issue: { number: 42 }
        });
        assert.strictEqual(event.comment.body, '/propr fix this bug');
        assert.strictEqual(event.issue.number, 42);
    });
});

describe('createWebhookIssueCommentCreatedEvent', () => {
    test('creates created event', () => {
        const event = createWebhookIssueCommentCreatedEvent({
            comment: { body: 'LGTM!' }
        });
        assert.strictEqual(event.action, 'created');
        assert.strictEqual(event.comment.body, 'LGTM!');
    });
});

describe('createWebhookIssueCommentDeletedEvent', () => {
    test('creates deleted event', () => {
        const event = createWebhookIssueCommentDeletedEvent();
        assert.strictEqual(event.action, 'deleted');
    });
});

describe('createWebhookIssueCommentEditedEvent', () => {
    test('creates edited event', () => {
        const event = createWebhookIssueCommentEditedEvent();
        assert.strictEqual(event.action, 'edited');
    });
});

// ========== Pull Request Event Factory Tests ==========

describe('createWebhookPullRequestEvent', () => {
    test('creates opened event by default', () => {
        const event = createWebhookPullRequestEvent();
        assert.strictEqual(event.action, 'opened');
        assert.ok(event.pull_request);
        assert.ok(event.repository);
        assert.strictEqual(event.number, event.pull_request.number);
    });

    test('creates event with custom PR', () => {
        const event = createWebhookPullRequestEvent({
            pullRequest: {
                number: 123,
                title: 'Feature PR',
                labels: ['auto-merge', 'enhancement']
            }
        });
        assert.strictEqual(event.pull_request.number, 123);
        assert.strictEqual(event.pull_request.title, 'Feature PR');
        assert.strictEqual(event.pull_request.labels.length, 2);
    });
});

describe('createWebhookPullRequestLabeledEvent', () => {
    test('creates labeled event with label', () => {
        const event = createWebhookPullRequestLabeledEvent({
            pullRequest: { number: 123, labels: ['auto-merge'] },
            label: { name: 'auto-merge' }
        });
        assert.strictEqual(event.action, 'labeled');
        assert.strictEqual((event as PullRequestLabeledEvent).label?.name, 'auto-merge');
    });
});

describe('createWebhookPullRequestClosedEvent', () => {
    test('creates closed event', () => {
        const event = createWebhookPullRequestClosedEvent({
            pullRequest: { number: 123 }
        });
        assert.strictEqual(event.action, 'closed');
        assert.strictEqual(event.pull_request.state, 'closed');
    });
});

// ========== PR Review Comment Event Factory Tests ==========

describe('createWebhookPRReviewCommentEvent', () => {
    test('creates created event by default', () => {
        const event = createWebhookPRReviewCommentEvent();
        assert.strictEqual(event.action, 'created');
        assert.ok(event.comment);
        assert.ok(event.pull_request);
        assert.ok(event.repository);
    });

    test('creates event with custom comment', () => {
        const event = createWebhookPRReviewCommentEvent({
            comment: {
                body: 'Please fix this',
                path: 'src/app.ts',
                line: 42
            },
            pullRequest: { number: 123 }
        });
        assert.strictEqual(event.comment.body, 'Please fix this');
        assert.strictEqual(event.comment.path, 'src/app.ts');
        assert.strictEqual(event.comment.line, 42);
    });
});

describe('createWebhookPRReviewCommentCreatedEvent', () => {
    test('creates created event', () => {
        const event = createWebhookPRReviewCommentCreatedEvent();
        assert.strictEqual(event.action, 'created');
    });
});

describe('createWebhookPRReviewCommentDeletedEvent', () => {
    test('creates deleted event', () => {
        const event = createWebhookPRReviewCommentDeletedEvent();
        assert.strictEqual(event.action, 'deleted');
    });
});

describe('createWebhookPRReviewCommentEditedEvent', () => {
    test('creates edited event', () => {
        const event = createWebhookPRReviewCommentEditedEvent();
        assert.strictEqual(event.action, 'edited');
    });
});

// ========== Check Run Event Factory Tests ==========

describe('createWebhookCheckRunEvent', () => {
    test('creates completed success event by default', () => {
        const event = createWebhookCheckRunEvent();
        assert.strictEqual(event.action, 'completed');
        assert.strictEqual(event.check_run.conclusion, 'success');
        assert.strictEqual(event.check_run.status, 'completed');
        assert.ok(event.check_run.head_sha);
        assert.ok(event.repository);
    });

    test('creates event with custom values', () => {
        const event = createWebhookCheckRunEvent({
            action: 'completed',
            conclusion: 'failure',
            checkRunName: 'Unit Tests',
            headSha: 'abc123',
            pullRequests: [{ number: 42 }, { number: 43 }]
        });
        assert.strictEqual(event.check_run.conclusion, 'failure');
        assert.strictEqual(event.check_run.name, 'Unit Tests');
        assert.strictEqual(event.check_run.head_sha, 'abc123');
        assert.strictEqual(event.check_run.pull_requests.length, 2);
        assert.strictEqual(event.check_run.pull_requests[0].number, 42);
    });

    test('creates in-progress event', () => {
        const event = createWebhookCheckRunEvent({
            action: 'created',
            status: 'in_progress'
        });
        assert.strictEqual(event.check_run.status, 'in_progress');
        assert.strictEqual(event.check_run.conclusion, null);
    });

    test('creates event with no PRs', () => {
        const event = createWebhookCheckRunEvent({
            pullRequests: []
        });
        assert.strictEqual(event.check_run.pull_requests.length, 0);
    });

    test('creates skipped check run', () => {
        const event = createWebhookCheckRunEvent({
            conclusion: 'skipped'
        });
        assert.strictEqual(event.check_run.conclusion, 'skipped');
    });
});

// ========== Integration Tests ==========

describe('Webhook Event Factory Integration', () => {
    test('all factories generate valid typed events', () => {
        // Issues events
        const issuesEvent = createWebhookIssuesEvent({ action: 'opened' });
        assert.ok(issuesEvent.issue);
        assert.ok(issuesEvent.repository);

        // Issue comment events
        const commentEvent = createWebhookIssueCommentCreatedEvent();
        assert.ok(commentEvent.comment);
        assert.ok(commentEvent.issue);

        // PR events
        const prEvent = createWebhookPullRequestEvent();
        assert.ok(prEvent.pull_request);
        assert.ok(prEvent.number);

        // PR review comment events
        const reviewCommentEvent = createWebhookPRReviewCommentCreatedEvent();
        assert.ok(reviewCommentEvent.comment);
        assert.ok(reviewCommentEvent.pull_request);

        // Check run events
        const checkRunEvent = createWebhookCheckRunEvent();
        assert.ok(checkRunEvent.check_run);
        assert.ok(checkRunEvent.check_run.pull_requests);
    });

    test('events can be customized for realistic scenarios', () => {
        // Scenario: AI label added to issue in a specific repo
        const labeledEvent = createWebhookIssuesLabeledEvent({
            repository: { owner: 'integry', name: 'gitfix' },
            issue: {
                number: 1160,
                title: 'Create Test Utilities: Webhook Event Factory',
                labels: ['AI', 'auto-merge']
            },
            label: { name: 'AI', color: '0366d6' },
            sender: { login: 'gitfixio[bot]', type: 'Bot' }
        });

        assert.strictEqual(labeledEvent.repository.full_name, 'integry/gitfix');
        assert.strictEqual(labeledEvent.issue.number, 1160);
        assert.strictEqual(labeledEvent.sender.type, 'Bot');

        // Scenario: Auto-merge check run completes successfully
        const checkRunEvent = createWebhookCheckRunEvent({
            repository: { owner: 'integry', name: 'gitfix' },
            pullRequests: [{ number: 1234 }],
            checkRunName: 'CI / build',
            conclusion: 'success',
            headSha: 'abc123def456'
        });

        assert.strictEqual(checkRunEvent.repository.full_name, 'integry/gitfix');
        assert.strictEqual(checkRunEvent.check_run.name, 'CI / build');
        assert.strictEqual(checkRunEvent.check_run.pull_requests[0].number, 1234);
    });
});
