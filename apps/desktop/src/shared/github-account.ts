/** Public identity only. Credentials and authorization never come from this display model. */
export interface DesktopGitHubAccount {
  id: string;
  username: string;
  avatarUrl: string | null;
}

export const parseDesktopGitHubAccount = (value: unknown): DesktopGitHubAccount | null => {
  if (!value || typeof value !== 'object') return null;
  const user = value as Record<string, unknown>;
  if (typeof user.id !== 'string' || !/^[0-9]{1,32}$/.test(user.id)
    || typeof user.username !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(user.username)) return null;
  // Only GitHub's public avatar host; never render an arbitrary authenticated URL.
  let avatarUrl: string | null = null;
  if (typeof user.avatarUrl === 'string') {
    try {
      const url = new URL(user.avatarUrl);
      if (url.origin === 'https://avatars.githubusercontent.com' && !url.username && !url.password) {
        avatarUrl = url.href;
      }
    } catch { /* An invalid avatar does not invalidate the identity. */ }
  }
  return { id: user.id, username: user.username, avatarUrl };
};
