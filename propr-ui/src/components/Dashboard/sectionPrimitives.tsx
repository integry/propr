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

/**
 * Repository slug as a monospace code chip.
 *
 * A repository is a technical entity, so it gets the same chip treatment as an
 * issue or a pull request rather than reading as prose. The icon rides inside
 * the chip so the two never separate when the metadata line wraps.
 *
 * The chip draws the repository name without its owner, in every section and
 * at every width. The owner is the constant: the filter above the console is
 * already scoped to this instance's repositories, so `example/` is eight
 * characters repeated down every row of every column — and in the narrow rail
 * it was eight characters spent to truncate the eight that actually identify
 * the repository, leaving `example/workspa…`. Dropping it in one column and
 * keeping it in the next was worse still: the same repository read as two
 * different entities on one screen. So the owner goes everywhere, and stays in
 * the chip's tooltip and in the icon beside it.
 */
export const RepositoryLabel: React.FC<{ repository: string }> = ({ repository }) => {
  const icons = useContext(RepositoryIconContext);
  const icon = icons.get(repository);
  const name = repository.slice(repository.lastIndexOf('/') + 1);
  return (
    <span
      className="inline-flex min-w-0 items-center gap-1 whitespace-nowrap rounded-sm border border-slate-200 bg-slate-100 px-1.5 py-0.5 font-mono text-[12px] leading-4 text-slate-800"
      title={repository}
    >
      <RepositoryIcon
        repository={repository}
        iconPath={icon?.iconPath}
        revision={icon?.revision}
        className="h-3.5 w-3.5 flex-none"
      />
      <span className="truncate">{name}</span>
    </span>
  );
};

/**
 * Issue or pull request reference, using the task list's code chip.
 *
 * The entity type is always spelled out. A bare `#2479` leaves the reader
 * guessing whether it is an issue or a pull request, so the prefix is not
 * optional — the chip is either `PR #n` or `Issue #n`.
 */
export const WorkReference: React.FC<{ issueNumber?: number | null; prNumber?: number | null }> = ({
  issueNumber,
  prNumber,
}) => {
  if (prNumber) return <ReferenceChip title={`Pull request #${prNumber}`}>PR #{prNumber}</ReferenceChip>;
  if (issueNumber) return <ReferenceChip title={`Issue #${issueNumber}`}>Issue #{issueNumber}</ReferenceChip>;
  return null;
};

/**
 * Utility header for a section.
 *
 * A ruled strip across the full width of its column, not the title of a
 * floating card: tinted background, a 1px rule beneath it, and the section's
 * own count carried inline as `HAPPENING NOW (6)` so a top-level number never
 * needs a box of its own. Zero is a count like any other: `NEEDS ATTENTION (0)`
 * above an all-clear line says the section looked and found nothing, where a
 * bare title leaves it ambiguous whether it ever loaded.
 *
 * `min-h-10` is the horizon line. Two panes sit side by side, and only some of
 * them carry a segmented control; without a shared minimum the header in one
 * column is 28px and the header beside it is 40px, so the rule under each one
 * lands on a different pixel and the split-pane reads as two separate boxes.
 * Forty is also the summary bar's height, so the whole console keeps one
 * chrome rhythm.
 */
export const SectionHeading: React.FC<{
  id: string;
  title: string;
  count?: number | null;
  children?: React.ReactNode;
}> = ({ id, title, count, children }) => (
  <div className="flex min-h-10 flex-none flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-slate-200 bg-slate-50 px-3 py-1.5">
    <h2 id={id} className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
      {title}
      {count !== undefined && count !== null && (
        <span className="tabular-nums"> ({count})</span>
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

/**
 * The bar that closes a list.
 *
 * Everything a section has to say after its last row — how much work is
 * queued, how many rows are still folded away — is said here, in one tinted
 * bar flush with the pane. A "Show N more" link left to float on its own
 * between the last row and a footer bar reads as a stray link dropped into
 * white space rather than as a control belonging to the list, so the section
 * gets one footer and the expand action lives inside it. The tint is what
 * marks it as a footer; it does not also need a rule above it.
 *
 * `mt-auto` makes it the pane's floor rather than a bar that trails the last
 * row. A pane in a split-pane console is as tall as the pane beside it, so one
 * running task next to three attention items left the queue bar pinned at
 * 260px with a quarter of a screen of white between it and the rule below,
 * which reads as content that failed to load. Held to the bottom, the list
 * area absorbs the slack and the pane keeps a solid baseline. In a pane
 * that is not a flex column the margin resolves to zero, so the bar still sits
 * directly under the last row it closes.
 */
export const SectionFooter: React.FC<{
  children: React.ReactNode;
  'data-testid'?: string;
}> = ({ children, ...rest }) => (
  <div
    className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 bg-slate-50 px-3 py-2 text-xs text-slate-600"
    {...rest}
  >
    {children}
  </div>
);

/** The expand/collapse control, sized and weighted to sit in a footer bar. */
export const SectionFooterButton: React.FC<{
  onClick: () => void;
  expanded: boolean;
  children: React.ReactNode;
}> = ({ onClick, expanded, children }) => (
  <button
    type="button"
    aria-expanded={expanded}
    onClick={onClick}
    className="-mx-1 rounded-sm px-1 font-medium text-slate-600 transition-colors hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500"
  >
    {children}
  </button>
);

/** Quiet, non-alarming empty state. An empty list is normal operation. */
export const SectionEmpty: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <p className="px-4 py-6 text-center text-sm text-slate-500">{children}</p>
);

/**
 * The empty state for a pane whose height is fixed by the pane beside it.
 *
 * A pane in a split-pane console cannot shrink to its content: the attention
 * panel is as tall as the running feed it shares a row with, whether it holds
 * four items or none. A single line of text pinned to the top of that pane
 * leaves 250px of unexplained white below it, which reads as content that
 * failed to load rather than as nothing to do.
 *
 * So the zero-state occupies the pane instead of sitting in it — a quiet glyph
 * above a sentence, centred on both axes. The height then looks deliberate,
 * and the pane still says the same thing it always said.
 */
export const SectionZeroState: React.FC<{
  icon: React.ReactNode;
  children: React.ReactNode;
  'data-testid'?: string;
}> = ({ icon, children, ...rest }) => (
  <p
    className="flex h-full flex-1 flex-col items-center justify-center gap-2 px-4 py-12 text-center text-sm leading-5 text-slate-400"
    {...rest}
  >
    {icon}
    <span>{children}</span>
  </p>
);

/**
 * A failed read. This is deliberately worded and styled differently from an
 * empty list: "nothing is happening" and "we could not find out" are not the
 * same fact, and only one of them offers a retry.
 */
export const SectionError: React.FC<{ message: string; onRetry: () => void }> = ({ message, onRetry }) => (
  <div className="px-3 py-3">
    <SystemAlert onRetry={onRetry}>{message}</SystemAlert>
  </div>
);

export const SectionSkeleton: React.FC<{ rows?: number }> = ({ rows = 3 }) => (
  <div className="animate-pulse space-y-2 px-3 py-3" data-testid="section-skeleton">
    {Array.from({ length: rows }, (_, index) => (
      <div key={index} className="h-10 rounded-sm bg-slate-100" />
    ))}
  </div>
);

/**
 * Metadata for a feed row in the wide column: two strict lines on a phone, one
 * line from `sm` up.
 *
 * The horizontal stream that reads well at 1440px explodes on a 390px screen.
 * Status, repository, entity and elapsed time wrapped wherever they ran out of
 * room, so a single item spent three lines on metadata before its title, and
 * the interpunct that separated two facts wrapped with the second one and
 * started a line as an orphaned bullet.
 *
 * So the phone gets an explicit structure instead of whatever `flex-wrap`
 * produces: what it is and how long it has been are the first line, opposite
 * ends; the entities it concerns are the second. `sm:contents` dissolves that
 * pairing above the breakpoint and the ordering classes put the four facts
 * back into one stream, so the desktop line is unchanged.
 *
 * Nothing here is separated by a typed delimiter. The app's one separator
 * glyph is the interpunct `·`, but an inline separator that can wrap
 * eventually does, and it starts the next line as an orphan; space and the
 * chips' own borders say the same thing here and cannot wrap away from what
 * they separate.
 */
export const RowMetaLines: React.FC<{
  status: React.ReactNode;
  entities: React.ReactNode;
  trailing?: React.ReactNode;
}> = ({ status, entities, trailing }) => (
  <span className="flex flex-col gap-1 text-xs sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-2 sm:gap-y-1">
    <span className="flex items-center justify-between gap-2 sm:contents">
      <span className="flex min-w-0 items-center sm:order-1">{status}</span>
      {trailing && (
        <span className="flex-none whitespace-nowrap text-gray-500 sm:order-3">{trailing}</span>
      )}
    </span>
    <span className="flex min-w-0 items-center gap-1.5 sm:order-2">{entities}</span>
  </span>
);

/** Titles wrap to two lines rather than being cut off mid-word. */
export const RowTitle: React.FC<{ children: React.ReactNode; strong?: boolean }> = ({ children, strong = true }) => (
  <span className={`mt-1 line-clamp-2 block break-words text-sm leading-5 ${strong ? 'font-medium text-slate-900' : 'text-slate-700'}`}>
    {children}
  </span>
);

/**
 * The secondary line under a title, always held to one line.
 *
 * `block` and `line-clamp-1` both set `display`, and `block` was winning, so
 * the clamp drew no line at all and a long progress line quietly wrapped to
 * three. Only the clamp is applied. Nothing on the dashboard unfolds this line
 * any more: the row links to the work, which carries it whole.
 */
export const RowDetail: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span className="mt-0.5 line-clamp-1 break-words text-xs leading-5 text-slate-500">
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
