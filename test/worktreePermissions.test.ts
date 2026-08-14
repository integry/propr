import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { getWorktreeOwnershipTargets } from '../packages/core/src/git/worktreeOperations.js';

test('agent ownership excludes linked-worktree Git metadata', () => {
    const worktreePath = path.join('/tmp', 'git-processor', 'worktrees', 'owner', 'repo', 'issue-1881');
    const linkedMetadataPath = path.join('/tmp', 'git-processor', 'clones', 'owner', 'repo', '.git', 'worktrees', 'issue-1881');

    const targets = getWorktreeOwnershipTargets(worktreePath);

    assert.deepEqual(targets, [worktreePath]);
    assert.ok(!targets.includes(linkedMetadataPath));
});
