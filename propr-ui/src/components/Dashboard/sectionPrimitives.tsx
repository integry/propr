/**
 * Shared row chrome for the dashboard sections.
 *
 * Row structure and metadata are deliberately the same vocabulary the inbox
 * uses — a metadata line of dot-separated facts, then a wrappable title, then
 * an optional secondary line — so a row means the same thing in both places.
 * Secondary metadata wraps or drops before a title is ever truncated.
 */

import React, { createContext, useContext } from 'react';
import { Link } from 'react-router-dom';
import { RepositoryIcon } from '../RepositoryIcon';
import { ReferenceChip } from '../TaskList/ReferenceChips';
import { SystemAlert } from '../ui/SystemAlert';
import { isExternalHref } from './sectionState';

/** Repository icons resolved once by the shell and read by every section. */
export interface RepositoryIconInfo {
  iconPath?: string | null;
  revision?: string | null;
}

const RepositoryIconContext = createContext<Map<string, RepositoryIconInfo>>(new Map());

export const RepositoryIconProvider: React.FC<{
  icons: Map<string, RepositoryIconInfo>;
  children: React.ReactNode;
}> = ({ icons, children }) => (
  <RepositoryIconContext.Provider value={icons}>{children}</RepositoryIconContext.Provider>
);

export const Dot: React.FC = () => <span className="text-gray-300" aria-hidden="true">•</span>;

/** Repository name with its icon, kept short enough to drop before a title does. */
export const RepositoryLabel: React.FC<{ repository: string }> = ({ repository }) => {
  const icons = useContext(RepositoryIconContext);
  const icon = icons.get(repository);
  return (
    <span className="inline-flex min-w-0 items-center gap-1 text-gray-500">
      <RepositoryIcon
        repository={repository}
        iconPath={icon?.iconPath}
        revision={icon?.revision}
        className="h-3.5 w-3.5"
      />
      <span className="truncate">{repository}</span>
    </span>
  );
};

/** Issue or pull request reference, using the task list's code chip. */
export const WorkReference: React.FC<{ issueNumber?: number | null; prNumber?: number | null }> = ({
  issueNumber,
  prNumber,
}) => {
  if (prNumber) return <ReferenceChip title={`Pull request #${prNumber}`}>PR #{prNumber}</ReferenceChip>;
  if (issueNumber) return <ReferenceChip title={`Issue #${issueNumber}`}>#{issueNumber}</ReferenceChip>;
  return null;
};

export const SectionHeading: React.FC<{
  id: string;
  title: string;
  count?: number | null;
  children?: React.ReactNode;
}> = ({ id, title, count, children }) => (
  <div className="flex flex-wrap items-center justify-between gap-2 px-1 pb-2">
    <h2 id={id} className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-gray-500">
      {title}
      {count !== undefined && count !== null && count > 0 && (
        <span className="font-semibold tabular-nums text-gray-400">{count}</span>
      )}
    </h2>
    {children && <div className="flex items-center gap-2 text-xs">{children}</div>}
  </div>
);

export const SectionLink: React.FC<{ to: string; children: React.ReactNode }> = ({ to, children }) => (
  <Link to={to} className="font-medium text-gray-500 transition-colors hover:text-gray-800">
    {children}
  </Link>
);

/** Quiet, non-alarming empty state. An empty list is normal operation. */
export const SectionEmpty: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <p className="px-4 py-6 text-center text-sm text-slate-500">{children}</p>
);

/**
 * A failed read. This is deliberately worded and styled differently from an
 * empty list: "nothing is happening" and "we could not find out" are not the
 * same fact, and only one of them offers a retry.
 */
export const SectionError: React.FC<{ message: string; onRetry: () => void }> = ({ message, onRetry }) => (
  <div className="px-1 py-1">
    <SystemAlert onRetry={onRetry}>{message}</SystemAlert>
  </div>
);

export const SectionSkeleton: React.FC<{ rows?: number }> = ({ rows = 3 }) => (
  <div className="animate-pulse space-y-2 px-1 py-2" data-testid="section-skeleton">
    {Array.from({ length: rows }, (_, index) => (
      <div key={index} className="h-12 rounded-lg bg-slate-100" />
    ))}
  </div>
);

/** Metadata line above a title. Secondary facts wrap or drop before a title truncates. */
export const RowMeta: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs">{children}</span>
);

/** Titles wrap to two lines rather than being cut off mid-word. */
export const RowTitle: React.FC<{ children: React.ReactNode; strong?: boolean }> = ({ children, strong = true }) => (
  <span className={`mt-1 line-clamp-2 block break-words text-sm leading-5 ${strong ? 'font-medium text-slate-900' : 'text-slate-700'}`}>
    {children}
  </span>
);

export const RowDetail: React.FC<{ children: React.ReactNode; clamp?: boolean }> = ({ children, clamp = true }) => (
  <span className={`mt-0.5 block break-words text-xs leading-5 text-slate-500 ${clamp ? 'line-clamp-1' : ''}`}>
    {children}
  </span>
);

/** One row destination, whether it lives in the app or on GitHub. */
export const RowLink: React.FC<{
  href: string;
  className?: string;
  children: React.ReactNode;
  'aria-label'?: string;
  'data-testid'?: string;
}> = ({ href, className = '', children, ...rest }) =>
  isExternalHref(href) ? (
    <a href={href} target="_blank" rel="noopener noreferrer" className={className} {...rest}>
      {children}
    </a>
  ) : (
    <Link to={href} className={className} {...rest}>
      {children}
    </Link>
  );
