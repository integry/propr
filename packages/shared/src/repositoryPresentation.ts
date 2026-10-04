import { createElement as h, Fragment, type ReactNode } from 'react';
import { Star } from 'lucide-react';

/** Presentation shared by the app's repository picker and server-rendered MCP consent. */
export interface RepositoryOption {
  name: string;
  baseBranch?: string;
  starred?: boolean;
  displayName?: string;
  iconPath?: string | null;
  iconRevision?: string | null;
}

export const repositoryKey = (repo: RepositoryOption): string =>
  repo.baseBranch ? `${repo.name}:${repo.baseBranch}` : repo.name;

export function sortRepositories<T extends RepositoryOption>(repos: T[]): T[] {
  const synthetic = repos.filter(repo => !repo.name.includes('/'));
  const normal = repos.filter(repo => repo.name.includes('/')).sort((a, b) =>
    a.name.localeCompare(b.name) || (a.baseBranch || '').localeCompare(b.baseBranch || ''));
  return [...synthetic, ...normal];
}

// Scoped CSS works in both Tailwind and nonce-protected server pages.
export const repositoryListStyles = `
.propr-repo-row{box-sizing:border-box;width:100%;margin:0;padding:8px 12px;border:0;border-radius:0;background:transparent;color:#374151;text-align:left;display:flex;align-items:center;gap:8px;cursor:pointer;transition:background-color .15s;font:inherit;line-height:1.5}
.propr-repo-row:hover{background:#f9fafb}
.propr-repo-row[data-selected="true"]{background:#eef2ff;color:#4338ca}
.propr-repo-row:has(input:checked){background:#eef2ff;color:#4338ca}
.propr-repo-row input{flex:none;margin:0;accent-color:#1d8a8a}
.propr-repo-row .propr-repo-icon{width:16px;height:16px;flex-shrink:0;border-radius:4px;object-fit:contain;color:#9ca3af}
.propr-repo-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:14px/20px ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono","Courier New",monospace}
.propr-repo-owner{color:#9ca3af}.propr-repo-slug{font-weight:500}.propr-repo-branch{color:#6b7280}
.propr-repo-star{width:14px;height:14px;color:#f59e0b;fill:#f59e0b;flex-shrink:0}
.propr-repo-section{padding:6px 12px;font:700 10px/15px Inter,system-ui,sans-serif;letter-spacing:.1em;text-transform:uppercase;color:#64748b;background:#f8fafc}
.propr-repo-empty{padding:16px 12px;font-size:14px;text-align:center;color:#6b7280}
`;

export function RepositoryName({ repo }: { repo: RepositoryOption }) {
  if (repo.displayName) return h(Fragment, null, repo.displayName);
  const parts = repo.name.split('/');
  return h(Fragment, null,
    parts.length === 2
      ? h(Fragment, null, h('span', { className: 'propr-repo-owner' }, `${parts[0]}/`), h('span', { className: 'propr-repo-slug' }, parts[1]))
      : repo.name,
    repo.baseBranch && h('span', { className: 'propr-repo-branch' }, ` (${repo.baseBranch})`));
}

export function RepositoryRow({ repo, icon, control, label, trailing, selected, onSelect }: {
  repo: RepositoryOption;
  icon: ReactNode;
  /** A native checkbox turns the same row into a consent label. */
  control?: ReactNode;
  label?: ReactNode;
  trailing?: ReactNode;
  selected?: boolean;
  onSelect?: () => void;
}) {
  return h(control ? 'label' : 'button', {
    className: 'propr-repo-row',
    ...(control ? {} : { type: 'button' as const, 'data-testid': 'repo-item', 'aria-pressed': selected ?? false, onClick: onSelect }),
    'data-selected': selected || undefined,
    'data-repository-name': repo.name,
  }, control, icon,
  h('span', { className: label ? 'flex-1 min-w-0' : 'propr-repo-name', title: repo.name }, label ?? h(RepositoryName, { repo })),
  trailing,
  repo.starred && h(Star, { className: 'propr-repo-star', 'aria-hidden': true }));
}

export function RepositoryGroups<T extends RepositoryOption>({ starredRepos, otherRepos, renderRow }: {
  starredRepos: T[];
  otherRepos: T[];
  renderRow: (repo: T) => ReactNode;
}) {
  if (!starredRepos.length && !otherRepos.length) return h('div', { className: 'propr-repo-empty' }, 'No repositories found');
  const section = (repos: T[], title?: string) => h('div', { 'data-repository-section': true },
    title && h('div', { className: 'propr-repo-section' }, title),
    repos.map(repo => h(Fragment, { key: repositoryKey(repo) }, renderRow(repo))));
  return h(Fragment, null,
    starredRepos.length > 0 && section(starredRepos, 'Starred'),
    otherRepos.length > 0 && section(otherRepos, starredRepos.length ? 'All Repositories' : undefined));
}
