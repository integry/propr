import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalAuthority as canonical, immutableAuthority, type Purpose } from './contracts.js';

/** Pure helpers shared by the hosted authority state machine. No I/O. */
export const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
export const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
export const copy = <T>(value: T): T => structuredClone(value);
export const custodySchema = z.strictObject({ locator: z.string().min(1).max(8192) });
export const commitmentSchema = z.strictObject({ keyId: z.string().min(1).max(160), digest: z.string().regex(/^[0-9a-f]{64}$/) });
/** Issuer source kinds permitted to reserve each purpose. Deep-frozen at runtime:
 * the outer catalog and every source array reject mutation, so a cast cannot admit a source. */
export const PURPOSE_SOURCES: Readonly<Record<Purpose, readonly string[]>> = immutableAuthority({
  'config-mutation': ['config'], 'credential-writer': ['login', 'run', 'migration'],
  'credential-use': ['login', 'run', 'probe', 'migration'],
  'provider-launch': ['login', 'run', 'probe', 'migration', 'retry', 'callback'],
});
