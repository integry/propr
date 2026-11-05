import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

// Same private credential trust root as visual-preview OAuth custody. Domain
// separation and authenticated associated data prohibit profile/revision swaps.
function key(environment: NodeJS.ProcessEnv): Buffer {
  const root = environment.PROPR_CREDENTIAL_ENCRYPTION_KEY?.trim() || environment.SYSTEM_TASK_SECRET?.trim() || environment.SESSION_SECRET?.trim();
  if (!root) throw new Error('Private credential encryption is not configured');
  return createHash('sha256').update('propr.extension-profiles.v1\0').update(root).digest();
}
export function sealExtensionSecrets(value: Record<string, string>, identity: string, environment: NodeJS.ProcessEnv): string {
  const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key(environment), iv);
  cipher.setAAD(Buffer.from(identity));
  const bytes = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return [iv, cipher.getAuthTag(), bytes].map(b => b.toString('base64')).join('.');
}
export function unsealExtensionSecrets(value: string, identity: string, environment: NodeJS.ProcessEnv): Record<string, string> {
  try {
    const [iv, tag, bytes] = value.split('.').map(s => Buffer.from(s, 'base64'));
    const decipher = createDecipheriv('aes-256-gcm', key(environment), iv); decipher.setAAD(Buffer.from(identity)); decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(bytes), decipher.final()]).toString());
  } catch { throw new Error('Private extension credentials unavailable'); }
}
