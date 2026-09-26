import type { DesktopGitHubAccount } from '../../../apps/desktop/src/shared/github-account';
import UserAvatar from './UserAvatar';

/** Shared display only; selecting this component never changes authorization. */
export const GitHubAccountIdentity = ({ account }: { account: DesktopGitHubAccount }) => (
  <span className="inline-flex items-center gap-2">
    <UserAvatar
      user={{ ...account, displayName: account.username }}
      className="flex h-6 w-6 flex-none items-center justify-center rounded-full border border-slate-200 object-cover text-[.55rem] font-bold"
      fallbackClassName="bg-slate-100 text-primary-700"
      decorative
      referrerPolicy="no-referrer"
    />
    <span>@{account.username}</span>
  </span>
);
