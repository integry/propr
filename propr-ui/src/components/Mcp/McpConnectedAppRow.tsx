import React, { useId, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { ProviderLogo } from '../ui/ProviderLogo';
import { CodeChip, ScopeBadge } from '../ui/CodeChip';
import { formatRelativeTime } from '../headerUtils';
import {
  REPOSITORY_PREVIEW_LIMIT,
  orderScopes,
  repositoryOverflowLabel,
  revokeAccessibleName,
  uniqueRepositories,
  visibleRepositories,
  type McpConnectedApp,
} from './mcpAppPresentation';

interface McpConnectedAppRowProps {
  app: McpConnectedApp;
  onRevoke: (id: string) => void;
  /** True while this app's revoke request is in flight. */
  revoking?: boolean;
}

const sectionLabelClass = 'mb-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-500';

export const McpConnectedAppRow: React.FC<McpConnectedAppRowProps> = ({ app, onRevoke, revoking = false }) => {
  const [expanded, setExpanded] = useState(false);
  const baseId = useId();
  const repositoriesId = `${baseId}-repositories`;
  const scopes = orderScopes(app.scopes);
  const totalRepositories = uniqueRepositories(app.repositories).length;
  const { visible, hiddenCount } = visibleRepositories(app.repositories, expanded);
  const collapsible = totalRepositories > REPOSITORY_PREVIEW_LIMIT;

  return (
    <li className="min-w-0 border-b border-slate-100 px-4 py-4 sm:px-6" data-testid={`mcp-app-${app.id}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex h-7 w-7 flex-none items-center justify-center rounded bg-slate-100 text-slate-600" aria-hidden="true">
            <ProviderLogo provider={app.name} className="h-4 w-4" />
          </span>
          <h3 className="min-w-0 truncate text-sm font-semibold text-slate-900" title={app.name}>{app.name}</h3>
        </div>
        <button
          type="button"
          onClick={() => onRevoke(app.id)}
          disabled={revoking}
          aria-label={revokeAccessibleName(app)}
          aria-busy={revoking || undefined}
          className="inline-flex flex-none items-center gap-1.5 rounded border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 transition-colors hover:border-red-200 hover:bg-red-50 hover:text-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {revoking && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
          Revoke access
        </button>
      </div>

      <p className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 pl-[38px] text-xs text-slate-500">
        <span title={new Date(app.connectedAt).toLocaleString()}>Connected {formatRelativeTime(app.connectedAt)}</span>
        {app.lastUsedAt !== undefined && (
          <>
            <span aria-hidden="true">·</span>
            {app.lastUsedAt === null
              ? <span>Never used</span>
              : <span title={new Date(app.lastUsedAt).toLocaleString()}>Last used {formatRelativeTime(app.lastUsedAt)}</span>}
          </>
        )}
        <span aria-hidden="true">·</span>
        <span className="inline-flex min-w-0 max-w-full items-center gap-1">ID: <CodeChip title={app.id}>{app.id}</CodeChip></span>
      </p>

      <div className="mt-3 space-y-3 pl-[38px]">
        <div role="group" aria-labelledby={`${baseId}-permissions`}>
          <div id={`${baseId}-permissions`} className={sectionLabelClass}>Permissions</div>
          <ul className="flex flex-wrap gap-1.5">
            {scopes.map(scope => <li key={scope}><ScopeBadge>{scope}</ScopeBadge></li>)}
          </ul>
        </div>

        <div role="group" aria-labelledby={`${baseId}-repositories-label`}>
          <div id={`${baseId}-repositories-label`} className={sectionLabelClass}>Repositories</div>
          {totalRepositories === 0 ? (
            <p className="text-xs text-slate-400">No repositories</p>
          ) : (
            <div className="flex flex-wrap items-center gap-1.5">
              <ul id={repositoriesId} className="flex min-w-0 max-w-full flex-wrap gap-1.5">
                {visible.map(repo => <li key={repo} className="min-w-0 max-w-full"><CodeChip title={repo}>{repo}</CodeChip></li>)}
              </ul>
              {collapsible && (
                <button
                  type="button"
                  aria-expanded={expanded}
                  aria-controls={repositoriesId}
                  onClick={() => setExpanded(value => !value)}
                  className="rounded px-1.5 py-0.5 text-xs font-medium text-slate-500 transition-colors hover:bg-slate-50 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
                >
                  {expanded ? 'Show fewer' : repositoryOverflowLabel(hiddenCount)}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </li>
  );
};
