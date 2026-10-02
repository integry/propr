/**
 * The repository scope, shown read-only in the global toolbar.
 *
 * Analytics always aggregates every repository, so it has no filter to offer.
 * Leaving the toolbar's scope slot empty would still make the header change
 * shape between tabs, though, and the scope is a fact worth stating. So the
 * page mounts this in the slot the Dashboard's selector uses, at the same
 * width and height: the same control, locked to `All Repos`.
 */

import React from 'react';
import { Layers, Lock } from 'lucide-react';

export const LockedRepositoryScope: React.FC = () => (
  <span
    data-testid="analytics-repository-scope"
    aria-label="Repository scope: All Repos (locked)"
    title="Analytics always covers every repository"
    className="flex h-7 w-36 min-w-0 cursor-default items-center gap-1.5 rounded-md border border-gray-300 bg-gray-50 px-2 text-xs text-gray-500 xl:w-48"
  >
    <Layers className="h-3.5 w-3.5 flex-none text-gray-400" aria-hidden="true" />
    <span className="min-w-0 flex-1 truncate text-left">All Repos</span>
    <Lock className="h-3.5 w-3.5 flex-none text-gray-400" aria-hidden="true" />
  </span>
);

export default LockedRepositoryScope;
