// Result list and live preview pane for the global search palette.
import React from 'react';
import { GitBranch, ScrollText, ListTodo, CornerDownLeft, ExternalLink } from 'lucide-react';
import type { MonitoredRepo } from '../api/proprApi';
import type { DraftListItem } from '../api/plannerApi';
import type { TaskSearchResult } from '../hooks/useGlobalSearch';
import { ScoreBadge } from './TaskList/ScoreBadge';
import { CodeChip } from './ui/CodeChip';
import {
  SearchItem,
  SECTION_LABELS,
  formatTimeAgo,
  getItemGithubUrl,
  getItemTitle,
  getRepoName,
  getSearchStatusStyle,
  searchOptionId,
} from './globalSearchModel';

const SECTION_ICONS: Record<SearchItem['kind'], typeof GitBranch> = {
  repository: GitBranch,
  plan: ScrollText,
  task: ListTodo,
};

const StatusText: React.FC<{ status: string }> = ({ status }) => (
  <span className={`inline-block rounded-sm px-1 font-mono text-[11px] leading-4 ${getSearchStatusStyle(status)}`}>
    {status.replace(/_/g, ' ')}
  </span>
);

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

const PreviewRow: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="flex items-baseline gap-2 text-xs">
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
      <PreviewRow label="Repo"><CodeChip>{plan.repository}</CodeChip></PreviewRow>
      <PreviewRow label="Status"><StatusText status={plan.paused ? 'paused' : plan.status} /></PreviewRow>
      {issues && issues.total > 0 && (
        <PreviewRow label="Issues">
          {issues.total} total · {issues.merged} merged · {issues.processing} running · {issues.pending} pending
        </PreviewRow>
      )}
      <PreviewRow label="Updated">{formatTimeAgo(plan.updated_at || plan.created_at)} ago</PreviewRow>
      {plan.name && plan.initial_prompt && (
        <p className="line-clamp-4 border-t border-slate-200 pt-2 text-xs leading-5 text-slate-500">{plan.initial_prompt}</p>
      )}
    </>
  );
};

const TaskDetails: React.FC<{ task: TaskSearchResult }> = ({ task }) => {
  const model = task.model || task.modelName;
  const reference = task.prNumber ? `PR #${task.prNumber}` : task.issueNumber ? `#${task.issueNumber}` : null;
  return (
    <>
      {task.repository && <PreviewRow label="Repo"><CodeChip>{task.repository}</CodeChip></PreviewRow>}
      {reference && <PreviewRow label="Ref"><CodeChip>{reference}</CodeChip></PreviewRow>}
      <PreviewRow label="Status"><StatusText status={task.status} /></PreviewRow>
      {model && <PreviewRow label="Model"><span className="font-mono">{model}</span></PreviewRow>}
      {task.score != null && <PreviewRow label="Score"><ScoreBadge score={task.score} bracketed /></PreviewRow>}
      <PreviewRow label="Created">{formatTimeAgo(task.createdAt)} ago</PreviewRow>
      {task.status === 'failed' && task.failedReason && (
        <p className="line-clamp-3 text-xs leading-5 text-red-600">{task.failedReason}</p>
      )}
      {task.subtitle && (
        <p className="line-clamp-3 border-t border-slate-200 pt-2 text-xs leading-5 text-slate-500">{task.subtitle}</p>
      )}
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
        <dl className="space-y-1.5">
          <PreviewDetails item={item} />
        </dl>
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
