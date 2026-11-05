import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyPushError, extractUnblockUrls } from '../packages/core/src/git/pushRejection.js';

const UNBLOCK_URL = 'https://github.com/octo-org/octo-repo/security/secret-scanning/unblock-secret/2Mf8bjCnMb7BJFkLxmEBhP2OkTm';

// Output of a push blocked by secret scanning push protection.
const PUSH_PROTECTION = `remote: error: GH013: Repository rule violations found for refs/heads/2736/salvage.
remote:
remote: - GITHUB PUSH PROTECTION
remote:   —————————————————————————————————————————
remote:     Resolve the following violations before pushing again
remote:
remote:     - Push cannot contain secrets
remote:
remote:
remote:      (?) Learn how to resolve a blocked push
remote:      https://docs.github.com/code-security/secret-scanning/working-with-secret-scanning-and-push-protection/working-with-push-protection-from-the-command-line#resolving-a-blocked-push
remote:
remote:
remote:       —— GitHub Personal Access Token ——————————————————————
remote:        locations:
remote:          - commit: 8728dbe67
remote:            path: README.md:4
remote:
remote:        (?) To push, remove secret from commit(s) or follow this URL to allow the secret.
remote:        ${UNBLOCK_URL}
remote:
remote:
To https://github.com/octo-org/octo-repo.git
 ! [remote rejected] 2736/salvage -> 2736/salvage (push declined due to repository rule violations)
error: failed to push some refs to 'https://github.com/octo-org/octo-repo.git'`;

const RULESET = `remote: error: GH013: Repository rule violations found for refs/heads/main.
remote: Review all repository rules at https://github.com/octo-org/octo-repo/rules?ref=refs%2Fheads%2Fmain
remote:
remote: - Changes must be made through a pull request.
remote:
remote: - Required status check "ci" is expected.
remote:
To https://github.com/octo-org/octo-repo.git
 ! [remote rejected] main -> main (push declined due to repository rule violations)
error: failed to push some refs to 'https://github.com/octo-org/octo-repo.git'`;

const BRANCH_PROTECTION = `remote: error: GH006: Protected branch update failed for refs/heads/main.
remote: error: Cannot force-push to this branch
To https://github.com/octo-org/octo-repo.git
 ! [remote rejected] main -> main (protected branch hook declined)
error: failed to push some refs to 'https://github.com/octo-org/octo-repo.git'`;

const NON_FAST_FORWARD = `To https://github.com/octo-org/octo-repo.git
 ! [rejected]        2736/salvage -> 2736/salvage (non-fast-forward)
error: failed to push some refs to 'https://github.com/octo-org/octo-repo.git'
hint: Updates were rejected because the tip of your current branch is behind
hint: its remote counterpart. If you want to integrate the remote changes,
hint: use 'git pull' before pushing again.`;

const FETCH_FIRST = `To https://github.com/octo-org/octo-repo.git
 ! [rejected]        main -> main (fetch first)
error: failed to push some refs to 'https://github.com/octo-org/octo-repo.git'
hint: Updates were rejected because the remote contains work that you do not
hint: have locally.`;

const AUTH_401 = `remote: Invalid username or token. Password authentication is not supported for Git operations.
fatal: Authentication failed for 'https://github.com/octo-org/octo-repo.git/'`;

const AUTH_403 = `remote: Permission to octo-org/octo-repo.git denied to propr-dev[bot].
fatal: unable to access 'https://github.com/octo-org/octo-repo.git/': The requested URL returned error: 403`;

const EXPIRED_TOKEN = `fatal: unable to access 'https://x-access-token:ghs_abcdefghijklmnopqrstuvwxyz0123456789@github.com/octo-org/octo-repo.git/': The requested URL returned error: 401`;

const CONNECTION_RESET = `error: RPC failed; curl 56 Recv failure: Connection reset by peer
send-pack: unexpected disconnect while reading sideband packet
fatal: the remote end hung up unexpectedly
Everything up-to-date`;

const DNS_FAILURE = `fatal: unable to access 'https://github.com/octo-org/octo-repo.git/': Could not resolve host: github.com`;

test('secret scanning push protection is classified with its unblock URL verbatim', () => {
    const diagnosis = classifyPushError(new Error(PUSH_PROTECTION));
    assert.equal(diagnosis.classification, 'push_protection');
    assert.deepEqual(diagnosis.unblockUrls, [UNBLOCK_URL]);
    assert.match(diagnosis.summary, /secret/i);
});

test('legacy GH009 secret detection is push protection', () => {
    assert.equal(classifyPushError('remote: error: GH009: Secrets detected! This push failed.').classification, 'push_protection');
});

test('ruleset and branch protection violations are classified together', () => {
    for (const output of [RULESET, BRANCH_PROTECTION]) {
        const diagnosis = classifyPushError(new Error(output));
        assert.equal(diagnosis.classification, 'ruleset_or_branch_protection');
        assert.deepEqual(diagnosis.unblockUrls, []);
    }
});

test('non-fast-forward rejections are classified', () => {
    assert.equal(classifyPushError(NON_FAST_FORWARD).classification, 'non_fast_forward');
    assert.equal(classifyPushError(FETCH_FIRST).classification, 'non_fast_forward');
});

test('401, 403 and expired-token failures are auth', () => {
    for (const output of [AUTH_401, AUTH_403, EXPIRED_TOKEN]) {
        assert.equal(classifyPushError(new Error(output)).classification, 'auth', output);
    }
});

test('connection resets and DNS failures are network', () => {
    assert.equal(classifyPushError(new Error(CONNECTION_RESET)).classification, 'network');
    assert.equal(classifyPushError(new Error(DNS_FAILURE)).classification, 'network');
});

test('unrecognised output is unknown', () => {
    assert.equal(classifyPushError(new Error('fatal: something unexpected happened')).classification, 'unknown');
});

test('the excerpt never contains installation tokens', () => {
    const diagnosis = classifyPushError(new Error(EXPIRED_TOKEN));
    assert.ok(!diagnosis.excerpt.includes('ghs_abcdefghijklmnopqrstuvwxyz0123456789'));
});

test('simple-git stderr is considered when the message omits it', () => {
    const error = Object.assign(new Error('git push failed'), { stderr: NON_FAST_FORWARD });
    assert.equal(classifyPushError(error).classification, 'non_fast_forward');
});

test('unblock URLs are deduplicated and lose trailing punctuation', () => {
    assert.deepEqual(extractUnblockUrls(`${UNBLOCK_URL}.\n${UNBLOCK_URL}`), [UNBLOCK_URL]);
});

test('unblock URL extraction stays linear on adversarial input', () => {
    const started = Date.now();
    assert.deepEqual(extractUnblockUrls(`${'http://'.repeat(50_000)}x ${','.repeat(50_000)}x`), []);
    assert.ok(Date.now() - started < 1000);
});
