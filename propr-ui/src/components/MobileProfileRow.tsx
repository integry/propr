import React from 'react';
import { LogOut } from 'lucide-react';
import type { CurrentUser } from '../api/proprTypes';
import UserAvatar from './UserAvatar';

// Identity and Sign out share a line while the name has room to be read;
// with narrow screens or enlarged text Sign out wraps beneath it instead of
// squeezing the name down to a couple of letters.
const MobileProfileRow: React.FC<{ user: CurrentUser; onLogout: () => void }> = ({ user, onLogout }) => (
  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
    <div className="flex min-w-0 flex-[1_1_10rem] items-center gap-3">
      <UserAvatar
        user={user}
        className="flex h-9 w-9 flex-none items-center justify-center rounded-full border border-slate-200 object-cover text-xs font-bold"
        fallbackClassName="bg-primary-100 text-primary-700"
        decorative
      />
      <div className="min-w-0 flex-1">
        <p className="break-words text-sm font-semibold text-slate-800">{user.displayName || user.username}</p>
        <p className="break-all text-xs text-slate-500">@{user.username}</p>
      </div>
    </div>
    <button
      type="button"
      onClick={onLogout}
      className="ml-auto inline-flex min-h-10 flex-none items-center gap-2 rounded-md px-3 text-sm font-medium text-slate-600 hover:bg-red-50 hover:text-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
    >
      <LogOut className="h-4 w-4" aria-hidden="true" />
      Sign out
    </button>
  </div>
);

export default MobileProfileRow;
