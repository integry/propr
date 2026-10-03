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

export const GITHUB_APP_NAME_MAX_LENGTH = 34;

export function githubAppPublicUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Provide an absolute HTTP(S) public URL.'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Use an HTTP(S) URL without credentials, query parameters, or a fragment.');
  }
  return url;
}

function githubAppName(options: GithubAppManifestOptions, url: URL): string {
  if (options.name !== undefined) {
    if ([...options.name].length > GITHUB_APP_NAME_MAX_LENGTH) {
      throw new Error(`GitHub App names cannot exceed ${GITHUB_APP_NAME_MAX_LENGTH} characters.`);
    }
    return options.name;
  }

  // Keep generated names within GitHub's limit and conservative validator
  // alphabet. In particular, URL punctuation such as dots, colons, and IPv6
  // brackets must not leak into the default name.
  const host = url.hostname.replace(/[^a-zA-Z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'self-hosted';
  return `ProPR-${host}`.slice(0, GITHUB_APP_NAME_MAX_LENGTH).replace(/-+$/g, '');
}

export function buildGithubAppManifest(options: GithubAppManifestOptions) {
  const url = githubAppPublicUrl(options.publicUrl);
  const base = url.href.replace(/\/$/, '');
  const webhook = options.webhookUrl ? githubAppPublicUrl(options.webhookUrl).href : `${base}/webhook`;
  return {
    name: githubAppName(options, url),
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
