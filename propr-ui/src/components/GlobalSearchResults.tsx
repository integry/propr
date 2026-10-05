// Result list and live preview pane for the global search palette.
import React from 'react';
import { GitBranch, ScrollText, ListTodo, CornerDownLeft, ExternalLink, XCircle } from 'lucide-react';
import type { MonitoredRepo } from '../api/proprApi';
import type { DraftListItem } from '../api/plannerApi';
import type { TaskSearchResult } from '../hooks/useGlobalSearch';
import { ScoreBadge } from './TaskList/ScoreBadge';
import { CodeChip } from './ui/CodeChip';
import { ProviderLogo } from './ui/ProviderLogo';
import { RepositoryChip } from './ui/RepositoryChip';
import { formatModelName } from '../utils/modelDisplay';
import {
  SearchItem,
  SECTION_LABELS,
  SearchStatusTone,
  formatTimeAgo,
  getItemDescription,
  getItemGithubUrl,
  getItemTitle,
  getRepoName,
  getSearchStatus,
  searchOptionId,
  splitFailureReason,
} from './globalSearchModel';

const SECTION_ICONS: Record<SearchItem['kind'], typeof GitBranch> = {
  repository: GitBranch,
  plan: ScrollText,
  task: ListTodo,
};

const STATUS_TONES: Record<SearchStatusTone, { pill: string; dot: string }> = {
  failed: { pill: 'bg-red-50 text-red-700 border-red-200/60', dot: 'bg-red-500' },
  active: { pill: 'bg-teal-50 text-teal-700 border-teal-200', dot: 'bg-teal-500 animate-pulse' },
  review: { pill: 'bg-amber-50 text-amber-700 border-amber-200', dot: 'bg-amber-500' },
  pending: { pill: 'bg-slate-100 text-slate-600 border-slate-200', dot: 'border border-slate-400' },
  merged: { pill: 'bg-violet-50 text-violet-700 border-violet-200', dot: 'bg-violet-500' },
  cancelled: { pill: 'bg-orange-50 text-orange-700 border-orange-200', dot: 'bg-orange-500' },
  done: { pill: 'bg-gray-100 text-gray-600 border-gray-200', dot: 'bg-gray-400' },
};

/** The standard `● Status` pill used by the task list. */
const StatusPill: React.FC<{ status: string }> = ({ status }) => {
  const { label, tone } = getSearchStatus(status);
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium leading-4 ${STATUS_TONES[tone].pill}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${STATUS_TONES[tone].dot}`} aria-hidden="true" />
      {label}
    </span>
  );
};

/** Repository chip with the owner stripped and the ⎇ mark, matching the result list; the tooltip keeps the full slug. */
const RepoChip: React.FC<{ repository: string }> = ({ repository }) => (
  <RepositoryChip
    repository={repository}
    label={getRepoName(repository)}
    icon={<GitBranch data-testid="repository-chip-icon" className="h-3 w-3 flex-shrink-0 self-center text-slate-500" aria-hidden="true" />}
  />
);

/** A failure reason as a diagnostic finding: icon, label, and file paths as code. */
const FailureNote: React.FC<{ reason: string }> = ({ reason }) => (
  <p data-testid="global-search-failure" className="flex items-start gap-1.5 text-xs leading-5 text-red-700">
    <XCircle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-red-500" aria-hidden="true" />
    <span className="min-w-0 break-words">
      <span className="font-semibold">Failed:</span>{' '}
      {splitFailureReason(reason).map((part, index) => part.path ? (
        <code key={index} className="rounded-sm border border-red-200 bg-red-50 px-1 py-0.5 font-mono text-[11px] text-red-700">{part.text}</code>
      ) : (
        <React.Fragment key={index}>{part.text}</React.Fragment>
      ))}
    </span>
  </p>
);

const Description: React.FC<{ text: string | null }> = ({ text }) => text ? (
  <p data-testid="global-search-description" className="line-clamp-4 border-t border-slate-200 pt-2 text-xs leading-5 text-slate-500">{text}</p>
) : null;

function itemMeta(item: SearchItem): string {
  switch (item.kind) {
    case 'repository':
      return 'Repository';
    case 'plan':
      return `${getRepoName(item.plan.repository)} · ${formatTimeAgo(item.plan.updated_at || item.plan.created_at)}`;
    case 'task':
      return `${item.task.repository ? getRepoName(item.task.repository) : 'unknown'} · ${formatTimeAgo(item.task.createdAt)}`;
  }
}

interface ResultListProps {
  items: SearchItem[];
  activeIndex: number;
  onHover: (index: number) => void;
  onSelect: (item: SearchItem) => void;
}

export const SearchResultList: React.FC<ResultListProps> = ({ items, activeIndex, onHover, onSelect }) => (
  <ul id="global-search-listbox" role="listbox" aria-label="Search results" className="py-1">
    {items.map((item, index) => {
      const startsSection = index === 0 || items[index - 1].kind !== item.kind;
      const Icon = SECTION_ICONS[item.kind];
      const active = index === activeIndex;
      return (
        <React.Fragment key={item.key}>
          {startsSection && (
            <li role="presentation" className="px-3 pb-1 pt-2 text-[10px] font-bold uppercase tracking-wider text-slate-500">
              {SECTION_LABELS[item.kind]}
            </li>
          )}
          <li
            id={searchOptionId(item.key)}
            role="option"
            aria-selected={active}
            onMouseMove={() => { if (!active) onHover(index); }}
            onMouseDown={e => e.preventDefault()}
            onClick={() => onSelect(item)}
            className={`mx-1 flex cursor-pointer items-start gap-2 rounded-sm border-l-2 px-2 py-1.5 ${
              active ? 'border-primary-500 bg-primary-500/10' : 'border-transparent'
            }`}
          >
            <Icon className={`mt-0.5 h-3.5 w-3.5 flex-shrink-0 ${active ? 'text-primary-600' : 'text-slate-400'}`} aria-hidden="true" />
            <span className="min-w-0 flex-1 break-words text-sm font-medium leading-5 text-slate-900">
              {getItemTitle(item)}
            </span>
            <span className="mt-0.5 flex-shrink-0 whitespace-nowrap text-[11px] text-slate-400">{itemMeta(item)}</span>
          </li>
        </React.Fragment>
      );
    })}
  </ul>
);

// Every row is at least one chip tall, so chip rows and plain-text rows share one rhythm.
const PreviewRow: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="flex min-h-7 items-center gap-2 text-xs">
    <dt className="w-16 flex-shrink-0 text-[10px] font-bold uppercase tracking-wider text-slate-500">{label}</dt>
    <dd className="min-w-0 flex-1 break-words text-slate-700">{children}</dd>
  </div>
);

const RepositoryDetails: React.FC<{ repo: MonitoredRepo }> = ({ repo }) => (
  <>
    {repo.alias && <PreviewRow label="Alias">{repo.alias}</PreviewRow>}
    <PreviewRow label="Branch"><CodeChip>{repo.baseBranch || 'default'}</CodeChip></PreviewRow>
    <PreviewRow label="Status">{repo.enabled ? 'Monitored' : 'Paused'}</PreviewRow>
  </>
);

const PlanDetails: React.FC<{ plan: DraftListItem }> = ({ plan }) => {
  const issues = plan.issue_summary;
  return (
    <>
      <PreviewRow label="Repo"><RepoChip repository={plan.repository} /></PreviewRow>
      <PreviewRow label="Status"><StatusPill status={plan.paused ? 'paused' : plan.status} /></PreviewRow>
      {issues && issues.total > 0 && (
        <PreviewRow label="Issues">
          {issues.total} total · {issues.merged} merged · {issues.processing} running · {issues.pending} pending
        </PreviewRow>
      )}
      <PreviewRow label="Updated">{formatTimeAgo(plan.updated_at || plan.created_at)} ago</PreviewRow>
    </>
  );
};

const TaskDetails: React.FC<{ task: TaskSearchResult }> = ({ task }) => {
  const model = task.model || task.modelName;
  const reference = task.prNumber ? `PR #${task.prNumber}` : task.issueNumber ? `#${task.issueNumber}` : null;
  return (
    <>
      {task.repository && <PreviewRow label="Repo"><RepoChip repository={task.repository} /></PreviewRow>}
      {reference && <PreviewRow label="Ref"><CodeChip>{reference}</CodeChip></PreviewRow>}
      <PreviewRow label="Status"><StatusPill status={task.status} /></PreviewRow>
      {model && (
        <PreviewRow label="Model">
          <span className="inline-flex min-w-0 items-center gap-1.5" title={model}>
            <ProviderLogo provider={model} className="h-3.5 w-3.5 flex-shrink-0 text-slate-500" />
            <span className="truncate">{formatModelName(model)}</span>
          </span>
        </PreviewRow>
      )}
      {task.score != null && <PreviewRow label="Score"><ScoreBadge score={task.score} bracketed /></PreviewRow>}
      <PreviewRow label="Created">{formatTimeAgo(task.createdAt)} ago</PreviewRow>
    </>
  );
};

const PreviewDetails: React.FC<{ item: SearchItem }> = ({ item }) => {
  switch (item.kind) {
    case 'repository':
      return <RepositoryDetails repo={item.repo} />;
    case 'plan':
      return <PlanDetails plan={item.plan} />;
    case 'task':
      return <TaskDetails task={item.task} />;
  }
};

const OPEN_LABELS: Record<SearchItem['kind'], string> = {
  repository: 'Open tasks',
  plan: 'Open plan',
  task: 'Open task',
};

interface PreviewProps {
  item: SearchItem;
  onOpen: (item: SearchItem) => void;
  shortcutKey: string;
}

export const SearchPreview: React.FC<PreviewProps> = ({ item, onOpen, shortcutKey }) => {
  const Icon = SECTION_ICONS[item.kind];
  const githubUrl = getItemGithubUrl(item);
  return (
    <div data-testid="global-search-preview" className="flex h-full flex-col">
      <div className="flex-1 space-y-3 overflow-y-auto p-4 scrollbar-subtle">
        <div className="flex items-start gap-2">
          <Icon className="mt-0.5 h-4 w-4 flex-shrink-0 text-slate-400" aria-hidden="true" />
          <h3 className="min-w-0 break-words text-sm font-semibold leading-5 text-slate-900">{getItemTitle(item)}</h3>
        </div>
        <dl>
          <PreviewDetails item={item} />
        </dl>
        {item.kind === 'task' && item.task.status === 'failed' && item.task.failedReason && (
          <FailureNote reason={item.task.failedReason} />
        )}
        <Description text={getItemDescription(item)} />
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-slate-200 px-4 py-2.5">
        <button
          type="button"
          onMouseDown={e => e.preventDefault()}
          onClick={() => onOpen(item)}
          className="inline-flex items-center gap-1.5 rounded-sm bg-primary-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-primary-500"
        >
          <CornerDownLeft className="h-3 w-3" aria-hidden="true" />
          {OPEN_LABELS[item.kind]}
        </button>
        {githubUrl && (
          <a
            href={githubUrl}
            target="_blank"
            rel="noopener noreferrer"
            onMouseDown={e => e.preventDefault()}
            className="inline-flex items-center gap-1.5 rounded-sm border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-600 hover:border-slate-300 hover:text-slate-900 focus:outline-none focus:ring-2 focus:ring-primary-500"
          >
            <ExternalLink className="h-3 w-3" aria-hidden="true" />
            GitHub
            <kbd className="font-sans text-[10px] text-slate-400">{shortcutKey}↵</kbd>
          </a>
        )}
      </div>
    </div>
  );
};
