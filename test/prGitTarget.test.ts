import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { resolvePullRequestGitTarget } from '../src/jobs/prGitTarget.js';

describe('resolvePullRequestGitTarget', () => {
    test('targets the contributor repository for a fork PR', () => {
        assert.deepEqual(resolvePullRequestGitTarget({
            ref: 'fix/browse-configured-branch-clean',
            repo: {
                name: 'propr',
                full_name: 'nrdgrrrl/propr',
                owner: { login: 'nrdgrrrl' },
            },
        }, { repoOwner: 'integry', repoName: 'propr' }), {
            branchName: 'fix/browse-configured-branch-clean',
            repoOwner: 'nrdgrrrl',
            repoName: 'propr',
            isFork: true,
        });
    });

    test('keeps same-repository PR git operations on the base repository', () => {
        assert.deepEqual(resolvePullRequestGitTarget({
            ref: 'feature/same-repository',
            repo: {
                name: 'propr',
                full_name: 'integry/propr',
                owner: { login: 'integry' },
            },
        }, { repoOwner: 'integry', repoName: 'propr' }), {
            branchName: 'feature/same-repository',
            repoOwner: 'integry',
            repoName: 'propr',
            isFork: false,
        });
    });

    test('falls back to the canonical full name when nested owner data is absent', () => {
        assert.deepEqual(resolvePullRequestGitTarget({
            ref: 'feature/fork',
            repo: { full_name: 'contributor/project-fork' },
        }, { repoOwner: 'integry', repoName: 'propr' }), {
            branchName: 'feature/fork',
            repoOwner: 'contributor',
            repoName: 'project-fork',
            isFork: true,
        });
    });

    test('rejects a deleted fork before starting an implementation agent', () => {
        assert.throws(
            () => resolvePullRequestGitTarget({ ref: 'feature/deleted-fork', repo: null }, { repoOwner: 'integry', repoName: 'propr' }),
            /head repository is unavailable or has been deleted/,
        );
    });
});
