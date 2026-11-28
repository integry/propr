/**
 * Who may use the first-visit setup wizard of a Fly dashboard launch (#3827).
 *
 * `<app>.fly.dev` is guessable, so the wizard is bound to a one-time setup
 * code that only the Machine's logs show (`fly logs`, or Monitoring in the
 * dashboard). Whoever enters it first claims the instance: the browser gets a
 * claim cookie, the code stops working, and every later request without that
 * cookie is refused, even with the right code. A fresh code is issued on each
 * boot until the instance is claimed. Once setup is complete the wizard never
 * starts again (launchConfig.ts) and this state is deleted.
 *
 * Only hashes are stored; the code is printed to the logs and the claim token
 * lives only in the claimant's cookie.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { LaunchStore } from './launchStore.js';

export const SETUP_ACCESS_FILE = 'setup.json';
export const SETUP_CLAIM_COOKIE = 'propr_setup_claim';

const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 12;
/** Failed code entries allowed per window before the wizard waits. */
const MAX_FAILURES = 5;
const FAILURE_WINDOW_MS = 60_000;

interface SetupAccessState {
    codeHash?: string;
    claimHash?: string;
    claimedAt?: string;
}

export type ClaimResult =
    | { ok: true; token: string }
    | { ok: false; reason: 'already_claimed' | 'invalid_code' | 'rate_limited' };

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

function sameHash(a: string | undefined, b: string): boolean {
    if (!a || a.length !== b.length) return false;
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/** Uppercase, drop separators and read the ambiguous letters as Crockford base32 does. */
export function normalizeSetupCode(raw: string): string {
    return raw.toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
}

export function formatSetupCode(code: string): string {
    return code.match(/.{1,4}/g)?.join('-') ?? code;
}

export interface SetupAccess {
    /** Issue this boot's code (null once claimed). Print it to the logs. */
    issueCode(): string | null;
    claimed(): boolean;
    claim(code: string): ClaimResult;
    isClaimant(token: string | undefined): boolean;
    /** Setup is done: forget the code and the claim. */
    close(): void;
}

export function createSetupAccess(
    store: LaunchStore,
    options: { random?: (size: number) => Buffer; now?: () => number } = {},
): SetupAccess {
    const random = options.random ?? randomBytes;
    const now = options.now ?? Date.now;
    let failures: number[] = [];
    const read = (): SetupAccessState => store.readJson<SetupAccessState>(SETUP_ACCESS_FILE) ?? {};
    return {
        issueCode() {
            const state = read();
            if (state.claimHash) return null;
            const bytes = random(CODE_LENGTH);
            const code = [...bytes].map(byte => CODE_ALPHABET[byte & 31]).join('');
            store.writeJson(SETUP_ACCESS_FILE, { codeHash: sha256(code) } satisfies SetupAccessState);
            return code;
        },
        claimed() {
            return Boolean(read().claimHash);
        },
        claim(code) {
            const state = read();
            if (state.claimHash) return { ok: false, reason: 'already_claimed' };
            const at = now();
            failures = failures.filter(time => at - time < FAILURE_WINDOW_MS);
            if (failures.length >= MAX_FAILURES) return { ok: false, reason: 'rate_limited' };
            if (!sameHash(state.codeHash, sha256(normalizeSetupCode(code)))) {
                failures.push(at);
                return { ok: false, reason: 'invalid_code' };
            }
            const token = random(32).toString('base64url');
            store.writeJson(SETUP_ACCESS_FILE, { claimHash: sha256(token), claimedAt: new Date(at).toISOString() } satisfies SetupAccessState);
            return { ok: true, token };
        },
        isClaimant(token) {
            if (!token) return false;
            return sameHash(read().claimHash, sha256(token));
        },
        close() {
            store.remove(SETUP_ACCESS_FILE);
        },
    };
}
