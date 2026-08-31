import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DockerGoalSessionRecovery } from '../src/agents/goalSession/DockerGoalSessionRecovery.js';
import { fingerprintGoalWorktree } from '../src/agents/goalSession/worktreeIdentity.js';

const gitPath = '/usr/bin/git';

function createRepository(): { root: string; head: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-recovery-repository-'));
    execFileSync(gitPath, ['init', '--initial-branch=actual-branch', root]);
    execFileSync(gitPath, ['config', 'user.email', 'goal-test@example.invalid'], { cwd: root });
    execFileSync(gitPath, ['config', 'user.name', 'Goal Test'], { cwd: root });
    fs.writeFileSync(path.join(root, 'checkpoint.txt'), 'authoritative checkout\n');
    execFileSync(gitPath, ['add', 'checkpoint.txt'], { cwd: root });
    execFileSync(gitPath, ['commit', '-m', 'authoritative checkout'], { cwd: root });
    execFileSync(gitPath, ['remote', 'add', 'origin', 'https://github.com/foreign/replacement.git'], { cwd: root });
    const head = execFileSync(gitPath, ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    return { root, head };
}

test('repository recovery observes origin, branch, head, and root from Git instead of expected request values', async () => {
    const { root, head } = createRepository();
    const recovery = new DockerGoalSessionRecovery('/bin/false', gitPath);
    const expected = {
        repository: 'integry/propr',
        worktreePath: root,
        branch: 'expected-branch',
        headSha: 'expected-head',
    };
    const inspection = await recovery.inspectRepository(expected);

    assert.equal(inspection.exists, true);
    assert.equal(inspection.observedRepository, 'https://github.com/foreign/replacement.git');
    assert.equal(inspection.observedBranch, 'actual-branch');
    assert.equal(inspection.observedHeadSha, head);
    assert.equal(inspection.resolvedWorktreePath, root);
    assert.equal(inspection.observedWorktreeFingerprint, fingerprintGoalWorktree({
        repository: 'https://github.com/foreign/replacement.git',
        worktreePath: root,
        branch: 'actual-branch',
        headSha: head,
    }));
    assert.notEqual(inspection.observedWorktreeFingerprint, fingerprintGoalWorktree(expected));
});

test('repository recovery refuses a path alias instead of reporting expected-derived checkout identity', async () => {
    const { root } = createRepository();
    const alias = `${root}-alias`;
    fs.symlinkSync(root, alias);
    const recovery = new DockerGoalSessionRecovery('/bin/false', gitPath);
    const inspection = await recovery.inspectRepository({
        repository: 'integry/propr',
        worktreePath: alias,
        branch: 'actual-branch',
        headSha: 'not-the-observed-head',
    });

    assert.equal(inspection.exists, true);
    assert.equal(inspection.resolvedWorktreePath, root);
    assert.match(inspection.reason ?? '', /symlink or alias/);
    assert.equal(inspection.observedWorktreeFingerprint, undefined);
});
