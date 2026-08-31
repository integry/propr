import type { GoalSessionJsonValue } from './contract.js';
import { GoalSessionContractError } from './errors.js';

const SENSITIVE_RECOVERY_KEY_SUFFIXES = ['apikey', 'authorization', 'credential', 'password', 'privatekey', 'secret', 'token'];
const SECRET_VALUE = /(?:\bBearer\s+[A-Za-z0-9._~+/-]+=*|\b(?:gh[oprsu]_|github_pat_|sk-|AKIA)[A-Za-z0-9_-]{8,}|\b(?:secret|token|password)[._:-][A-Za-z0-9_-]{6,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\s/@:]+:[^\s/@]+@|https?:\/\/[^\s/@]+@)/i;

/** Recovery metadata is durable state, never a credential transport. */
export function assertCredentialFreeRecoveryMetadata(value: GoalSessionJsonValue): void {
    const visit = (candidate: GoalSessionJsonValue, path: string): void => {
        if (candidate === undefined || typeof candidate === 'bigint' || typeof candidate === 'function' || typeof candidate === 'symbol') {
            throw new GoalSessionContractError(`Recovery metadata contains a non-JSON value at ${path}`, 'INVALID_RECOVERY_METADATA');
        }
        if (typeof candidate === 'number' && !Number.isFinite(candidate)) {
            throw new GoalSessionContractError(`Recovery metadata contains a non-finite number at ${path}`, 'INVALID_RECOVERY_METADATA');
        }
        if (typeof candidate === 'string' && SECRET_VALUE.test(candidate)) {
            throw new GoalSessionContractError(`Recovery metadata contains a credential-like value at ${path}`, 'RECOVERY_METADATA_CONTAINS_CREDENTIAL');
        }
        if (Array.isArray(candidate)) {
            candidate.forEach((item, index) => visit(item, `${path}[${index}]`));
            return;
        }
        if (candidate && typeof candidate === 'object') {
            const prototype = Object.getPrototypeOf(candidate);
            if (prototype !== Object.prototype && prototype !== null) {
                throw new GoalSessionContractError(`Recovery metadata contains a non-JSON object at ${path}`, 'INVALID_RECOVERY_METADATA');
            }
            for (const [key, nested] of Object.entries(candidate)) {
                const normalizedKey = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
                if (SENSITIVE_RECOVERY_KEY_SUFFIXES.some(suffix => normalizedKey.endsWith(suffix))) {
                    throw new GoalSessionContractError(`Recovery metadata cannot persist credential-like field "${key}"`, 'RECOVERY_METADATA_CONTAINS_CREDENTIAL');
                }
                visit(nested, `${path}.${key}`);
            }
        }
    };
    visit(value, '$');
}
