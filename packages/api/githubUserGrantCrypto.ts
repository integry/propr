import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const ENCRYPTION_CONTEXT = 'propr:github-user-grant:v1';

/** Envelope encryption for `github_user_grants` token columns. */
function encryptionKey(environment: NodeJS.ProcessEnv): Buffer {
  const secret = environment.PROPR_CREDENTIAL_ENCRYPTION_KEY?.trim()
    || environment.SYSTEM_TASK_SECRET?.trim()
    || environment.SESSION_SECRET?.trim();
  if (!secret) throw new Error('A credential encryption secret is required to store GitHub user grants');
  return createHash('sha256').update(ENCRYPTION_CONTEXT).update('\0').update(secret).digest();
}

export function encryptToken(token: string, environment: NodeJS.ProcessEnv): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(environment), iv);
  const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.');
}

export function decryptToken(value: string, environment: NodeJS.ProcessEnv): string {
  const [version, encodedIv, encodedTag, encodedValue] = value.split('.');
  if (version !== 'v1' || !encodedIv || !encodedTag || !encodedValue) throw new Error('Invalid GitHub user grant envelope');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(environment), Buffer.from(encodedIv, 'base64url'));
  decipher.setAuthTag(Buffer.from(encodedTag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(encodedValue, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}
