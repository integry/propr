/**
 * Opt-in test against real Docker and a GitHub App installation. The installation
 * must cover TASK, RELATED and EXCLUDED (private) repositories. TASK needs a PR
 * and an issue. Mutation probes use invalid payloads and git push --dry-run, so a
 * regression fails the test without merging, publishing a branch or posting.
 *
 * PROPR_GITHUB_BOUNDARY_TEST=1
 * PROPR_GITHUB_BOUNDARY_TASK=owner/task
 * PROPR_GITHUB_BOUNDARY_RELATED=owner/library
 * PROPR_GITHUB_BOUNDARY_EXCLUDED=owner/private
 * PROPR_GITHUB_BOUNDARY_PR=1 PROPR_GITHUB_BOUNDARY_ISSUE=1
 * PROPR_GITHUB_BOUNDARY_IMAGE=propr/agent:latest
 * Plus normal own-App or scoped-token-capable relay authentication.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const enabled = process.env.PROPR_GITHUB_BOUNDARY_TEST === '1';

test('real container tokens allow context reads, deny GitHub writes and enforce read-only git mounts', { skip: !enabled, timeout: 180_000 }, async () => {
    const { getAuthenticatedOctokit } = await import('../packages/core/src/auth/githubAuth.js');
    const { mintAgentGitHubToken, buildAgentGitCredentialArgs, buildAgentGitMountArgs } = await import('../packages/core/src/agents/agentGitAccess.js');
    const octokit = await getAuthenticatedOctokit();
    const required = (name: string) => {
        assert.ok(process.env[name], `${name} must be set`);
        return process.env[name]!;
    };
    const task = required('PROPR_GITHUB_BOUNDARY_TASK');
    const related = required('PROPR_GITHUB_BOUNDARY_RELATED');
    const excluded = required('PROPR_GITHUB_BOUNDARY_EXCLUDED');
    const pr = required('PROPR_GITHUB_BOUNDARY_PR');
    const issue = required('PROPR_GITHUB_BOUNDARY_ISSUE');
    const image = process.env.PROPR_GITHUB_BOUNDARY_IMAGE || 'propr/agent:latest';
    await fs.mkdir('/tmp/git-processor', { recursive: true });
    const root = await fs.mkdtemp('/tmp/git-processor/boundary-test-');
    const workspace = `${root}/task`;
    await fs.mkdir(`${workspace}/.git`, { recursive: true });
    await fs.mkdir(`${root}/sibling`);
    await fs.writeFile(`${workspace}/.git/marker`, 'worker git metadata');
    await fs.writeFile(`${root}/sibling/marker`, 'sibling checkout');
    const script = String.raw`
const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const run = (args, input) => spawnSync('gh', args, { encoding: 'utf8', input });
const ok = args => { const r = run(args); assert.equal(r.status, 0, r.stderr); };
const denied = (method, endpoint, payload) => {
  const r = run(['api', '--method', method, endpoint, '--input', '-'], JSON.stringify(payload));
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /HTTP 403/, r.stderr);
};
ok(['repo', 'view', process.env.RELATED, '--json', 'name']);
ok(['issue', 'view', process.env.ISSUE, '--repo', process.env.TASK, '--json', 'title']);
ok(['pr', 'view', process.env.PR, '--repo', process.env.TASK, '--json', 'title']);
if (process.env.HAS_CI_READS === '1') {
const checks = run(['pr', 'checks', process.env.PR, '--repo', process.env.TASK, '--json', 'name,state']);
assert.ok([0, 1, 8].includes(checks.status) && !/HTTP 40[13]/.test(checks.stderr), checks.stderr);
assert.ok(Array.isArray(JSON.parse(checks.stdout)), 'gh pr checks must return check data');
}
const git = args => spawnSync('git', args, { encoding: 'utf8' });
assert.equal(git(['clone', '--depth=1', 'https://github.com/' + process.env.RELATED + '.git', '/tmp/context-clone']).status, 0);
assert.equal(git(['-C', '/tmp/context-clone', 'fetch', 'origin']).status, 0);
const push = git(['-C', '/tmp/context-clone', 'push', '--dry-run', 'origin', 'HEAD:refs/heads/propr-boundary-probe']);
assert.notEqual(push.status, 0);
assert.match(push.stderr, /403|denied|not permitted/i);
denied('POST', 'repos/' + process.env.TASK + '/issues/' + process.env.ISSUE + '/comments', { body: '' });
denied('POST', 'repos/' + process.env.TASK + '/issues/' + process.env.ISSUE + '/labels', { labels: 123 });
denied('PUT', 'repos/' + process.env.TASK + '/pulls/' + process.env.PR + '/merge', { sha: '0'.repeat(40) });
fs.writeFileSync('/home/node/workspace/edit.txt', 'agent edit');
assert.throws(() => fs.writeFileSync('/home/node/workspace/.git/marker', 'forbidden'), /EROFS|EACCES/);
assert.throws(() => fs.writeFileSync(process.env.SIBLING + '/marker', 'forbidden'), /EROFS|EACCES/);
if (process.env.SCOPED === '1') {
  const deniedRepo = run(['api', 'repos/' + process.env.EXCLUDED]);
  assert.notEqual(deniedRepo.status, 0);
  assert.match(deniedRepo.stderr, /HTTP 404/);
} else { ok(['api', 'repos/' + process.env.EXCLUDED]); }
`;
    try {
        const ids = await Promise.all([task, related].map(async name => {
            const [owner, repo] = name.split('/');
            return (await octokit.request('GET /repos/{owner}/{repo}', { owner, repo })).data.id;
        }));
        const [owner, repo] = excluded.split('/');
        assert.equal((await octokit.request('GET /repos/{owner}/{repo}', { owner, repo })).data.private, true);
        const grants = (await octokit.auth({ type: 'installation' }) as { permissions?: Record<string, string> }).permissions;
        const hasCiReads = ['checks', 'actions', 'statuses'].every(key => ['read', 'write'].includes(grants?.[key] ?? ''));
        for (const scoped of [false, true]) {
            const token = await mintAgentGitHubToken(octokit, false, scoped ? ids : undefined);
            await exec('docker', ['run', '--rm', '--entrypoint', 'node',
                '-v', `${workspace}:/home/node/workspace:rw`, ...buildAgentGitMountArgs(workspace),
                ...buildAgentGitCredentialArgs(), ...['GH_TOKEN', 'TASK', 'RELATED', 'EXCLUDED', 'ISSUE', 'PR', 'SIBLING', 'SCOPED', 'HAS_CI_READS'].flatMap(name => ['-e', name]),
                image, '-e', script], {
                env: { ...process.env, GH_TOKEN: token, TASK: task, RELATED: related, EXCLUDED: excluded,
                    ISSUE: issue, PR: pr, SIBLING: `${root}/sibling`, SCOPED: scoped ? '1' : '0', HAS_CI_READS: hasCiReads ? '1' : '0' },
                timeout: 80_000,
            });
        }
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});


test('worker credentials support private clone, fetch and dry-run push with credential-free remotes', { skip: !enabled, timeout: 90_000 }, async () => {
    const { getAuthenticatedOctokit, getGitHubInstallationToken } = await import('../packages/core/src/auth/githubAuth.js');
    const { createHooklessGit } = await import('../packages/core/src/git/hooklessGit.js');
    const { configureGitAuthentication, configureGitRemoteAuthentication } = await import('../packages/core/src/git/repoBranching.js');
    const repository = process.env.PROPR_GITHUB_BOUNDARY_EXCLUDED!;
    assert.ok(repository, 'PROPR_GITHUB_BOUNDARY_EXCLUDED must identify a private installation repository');
    const [owner, repo] = repository.split('/');
    const octokit = await getAuthenticatedOctokit();
    assert.equal((await octokit.request('GET /repos/{owner}/{repo}', { owner, repo })).data.private, true);
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const root = await fs.mkdtemp(join(tmpdir(), 'propr-worker-git-smoke-'));
    try {
        const clonePath = join(root, 'clone');
        const cloneGit = createHooklessGit();
        configureGitAuthentication(cloneGit, await getGitHubInstallationToken());
        await cloneGit.clone(`https://github.com/${repository}.git`, clonePath, ['--depth=1']);
        const git = createHooklessGit(clonePath);
        await configureGitRemoteAuthentication(git);
        await git.fetch(['origin']);
        await git.raw(['push', '--dry-run', 'origin', 'HEAD:refs/heads/propr-worker-auth-smoke']);
        assert.doesNotMatch(await fs.readFile(join(clonePath, '.git', 'config'), 'utf8'), /x-access-token|AUTHORIZATION|ghs_/i);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});
