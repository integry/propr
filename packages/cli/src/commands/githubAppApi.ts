import { createSign } from 'node:crypto';
import { GITHUB_APP_PERMISSIONS, SUPPORTED_WEBHOOK_EVENTS } from '@propr/shared';

export interface AppCredentials {
  id: number;
  slug: string;
  pem: string;
  webhook_secret: string;
  client_id: string;
  client_secret: string;
}
export interface AppInstallation {
  id: number;
  app_id: number;
  permissions: Record<string, string>;
  events: string[];
}
export interface AppCheck {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
}

export function appJwt(id: string | number, pem: string): string {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const payload = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iat: now - 60, exp: now + 540, iss: String(id) })}`;
  try {
    const signature = createSign('RSA-SHA256').update(payload).sign(pem, 'base64url');
    return `${payload}.${signature}`;
  } catch { throw new Error('Cannot sign a GitHub App JWT. Check the private key file.'); }
}

/** Never include response bodies, request URLs (conversion codes), or headers in errors. */
export async function githubAppRequest<T>(path: string, jwt?: string, method = 'GET', body?: unknown, fetcher = fetch): Promise<T> {
  let response: Response;
  try {
    response = await fetcher(`https://api.github.com${path}`, {
      method, redirect: 'error', signal: AbortSignal.timeout(20_000),
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
        ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch { throw new Error('GitHub API request failed. Check your network connection and retry.'); }
  if (!response.ok) {
    if (path.startsWith('/app-manifests/')) {
      throw new Error(`GitHub rejected the manifest code (HTTP ${response.status}). It may be expired or already used; restart github-app create within one hour.`);
    }
    throw new Error(`GitHub App API request failed (HTTP ${response.status}). Check App permissions and installation access.`);
  }
  try { return await response.json() as T; }
  catch { throw new Error('GitHub returned an invalid API response.'); }
}

export function installationChecks(installation: AppInstallation): AppCheck[] {
  const out: AppCheck[] = [];
  for (const [permission, required] of Object.entries(GITHUB_APP_PERMISSIONS)) {
    const actual = installation.permissions?.[permission];
    const ok = actual === 'write' || actual === required;
    out.push({ name: `GitHub ${permission}`, status: ok ? 'ok' : 'warn',
      detail: ok ? `${permission}: ${actual}` : `${permission}: requires ${required}; ${permission === 'actions' ? 'CI cancellation is inert without Actions write access. ' : ''}Update App permissions and approve them on the installation.` });
  }
  const missing = SUPPORTED_WEBHOOK_EVENTS.filter(event => !installation.events?.includes(event));
  out.push({ name: 'GitHub events', status: missing.length ? 'warn' : 'ok',
    detail: missing.length ? `Missing subscriptions: ${missing.join(', ')}. Update the App's event subscriptions.` : 'All supported webhook events are subscribed.' });
  if (installation.permissions?.workflows !== 'write') {
    out.push({ name: 'GitHub workflows', status: 'warn', detail: 'Workflows write is absent: pushes that create or modify .github/workflows/* will fail. Enable it in App settings or create with --allow-workflow-changes.' });
  }
  return out;
}

/** Used after creation and by propr check; minting a token proves usable installation auth. */
export async function checkGithubApp(id: string | number, installationId: string | number, pem: string, fetcher = fetch): Promise<AppCheck[]> {
  if (!/^\d+$/.test(String(installationId))) throw new Error('Invalid GitHub installation ID.');
  const jwt = appJwt(id, pem);
  const installation = await githubAppRequest<AppInstallation>(`/app/installations/${installationId}`, jwt, 'GET', undefined, fetcher);
  if (String(installation.app_id) !== String(id) || String(installation.id) !== String(installationId)) {
    throw new Error('GitHub installation does not belong to this App.');
  }
  const token = await githubAppRequest<{ token: string }>(`/app/installations/${installationId}/access_tokens`, jwt, 'POST', undefined, fetcher);
  if (!token.token) throw new Error('GitHub did not return an installation token.');
  return [{ name: 'GitHub installation token', status: 'ok', detail: 'Successfully minted an installation token.' }, ...installationChecks(installation)];
}
