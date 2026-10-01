/** Shared by webhook dispatch, App registration, and installation diagnostics. */
export const SUPPORTED_WEBHOOK_EVENTS = [
  'issues', 'issue_comment', 'pull_request_review_comment',
  'pull_request', 'check_run', 'push', 'status',
] as const;

export const GITHUB_APP_PERMISSIONS = {
  contents: 'write',
  issues: 'write',
  pull_requests: 'write',
  metadata: 'read',
  checks: 'read',
  statuses: 'read',
  actions: 'write',
} as const;

export interface GithubAppManifestOptions {
  publicUrl: string;
  name?: string;
  webhookUrl?: string;
  redirectUrl?: string;
  setupUrl?: string;
  allowWorkflowChanges?: boolean;
}

export function githubAppPublicUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Provide an absolute HTTP(S) public URL.'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Use an HTTP(S) URL without credentials, query parameters, or a fragment.');
  }
  return url;
}

export function buildGithubAppManifest(options: GithubAppManifestOptions) {
  const url = githubAppPublicUrl(options.publicUrl);
  const base = url.href.replace(/\/$/, '');
  const webhook = options.webhookUrl ? githubAppPublicUrl(options.webhookUrl).href : `${base}/webhook`;
  return {
    name: options.name || `ProPR (${url.host})`,
    url: base,
    hook_attributes: { url: webhook, active: true },
    ...(options.redirectUrl ? { redirect_url: options.redirectUrl } : {}),
    ...(options.setupUrl ? { setup_url: options.setupUrl } : {}),
    callback_urls: [`${base}/api/auth/github/callback`],
    public: false,
    default_events: [...SUPPORTED_WEBHOOK_EVENTS],
    default_permissions: {
      ...GITHUB_APP_PERMISSIONS,
      ...(options.allowWorkflowChanges ? { workflows: 'write' as const } : {}),
    },
  };
}
