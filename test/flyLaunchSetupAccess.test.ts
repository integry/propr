/**
 * Fly dashboard launch (#3827): the setup wizard is bound to a one-time code
 * from the logs and to the single browser that claims it.
 * Run with: npx tsx --test test/flyLaunchSetupAccess.test.ts
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { createLaunchStore } from '../src/flyLaunch/launchStore.ts';
import { createSetupAccess, formatSetupCode, normalizeSetupCode, SETUP_ACCESS_FILE } from '../src/flyLaunch/setupAccess.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function freshStore() {
    const root = mkdtempSync(join(tmpdir(), 'fly-launch-access-'));
    dirs.push(root);
    return createLaunchStore(join(root, 'fly-launch'));
}

test('a setup code is issued while unclaimed; only its hash is stored', () => {
    const store = freshStore();
    const access = createSetupAccess(store);
    const code = access.issueCode()!;
    assert.match(code, /^[0-9A-Z]{12}$/);
    const raw = readFileSync(store.path(SETUP_ACCESS_FILE), 'utf8');
    assert.ok(!raw.includes(code));
    assert.equal(statSync(store.path(SETUP_ACCESS_FILE)).mode & 0o777, 0o600);
    assert.equal(access.claimed(), false);
});

test('the code claims the instance once; the claim token identifies the claimant', () => {
    const store = freshStore();
    const access = createSetupAccess(store);
    const code = access.issueCode()!;
    const claim = access.claim(formatSetupCode(code).toLowerCase());
    assert.equal(claim.ok, true);
    assert.ok(claim.ok && access.isClaimant(claim.token));
    assert.equal(access.isClaimant('someone-else'), false);
    assert.equal(access.isClaimant(undefined), false);
    // A second claim, even with the right code, is refused.
    assert.deepEqual(access.claim(code), { ok: false, reason: 'already_claimed' });
    // The claim survives a restart and no new code is issued for it.
    const restarted = createSetupAccess(store);
    assert.equal(restarted.claimed(), true);
    assert.equal(restarted.issueCode(), null);
    assert.ok(claim.ok && restarted.isClaimant(claim.token));
});

test('a wrong code is refused and repeated wrong codes are rate limited', () => {
    const store = freshStore();
    let now = 1_000_000;
    const access = createSetupAccess(store, { now: () => now });
    const code = access.issueCode()!;
    for (let i = 0; i < 5; i++) assert.deepEqual(access.claim('AAAA-AAAA-AAAA'), { ok: false, reason: 'invalid_code' });
    assert.deepEqual(access.claim(code), { ok: false, reason: 'rate_limited' });
    now += 61_000;
    assert.equal(access.claim(code).ok, true);
});

test('each boot before the claim issues a new code and the old one stops working', () => {
    const store = freshStore();
    const first = createSetupAccess(store).issueCode()!;
    const access = createSetupAccess(store);
    const second = access.issueCode()!;
    assert.notEqual(first, second);
    assert.deepEqual(access.claim(first), { ok: false, reason: 'invalid_code' });
    assert.equal(access.claim(second).ok, true);
});

test('closing setup forgets the code and the claim', () => {
    const store = freshStore();
    const access = createSetupAccess(store);
    const claim = access.claim(access.issueCode()!);
    access.close();
    assert.equal(store.readJson(SETUP_ACCESS_FILE), undefined);
    assert.ok(claim.ok && !access.isClaimant(claim.token));
});

test('code entry tolerates separators, case and look-alike letters', () => {
    assert.equal(normalizeSetupCode(' ab0o-1il '), 'AB00111');
    assert.equal(formatSetupCode('ABCDEFGHJKMN'), 'ABCD-EFGH-JKMN');
});
