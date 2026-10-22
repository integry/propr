import React from 'react';
import { RepositoryIcon } from '../RepositoryIcon';

interface RepositoryChipProps {
  repository: string;
  /** Text to show in place of the full slug (e.g. the name without its owner); the tooltip keeps the slug. */
  label?: string;
  /** Repository-relative path to a custom icon; the chip shows no icon at all when absent. */
  iconPath?: string | null;
  revision?: string | null;
  className?: string;
  title?: string;
  /** Replaces the repository's own icon, e.g. the git-branch mark used by compact entity tokens. */
  icon?: React.ReactNode;
  /**
   * Opt-in for a page's primary repository identity: below `sm` the owner sits on its own line above the
   * name and both wrap instead of truncating, so the full slug stays readable on a phone without a tooltip.
   * From `sm` up the chip is the usual one-line compact chip.
   */
  stackOnNarrow?: boolean;
}

const narrowWrap = 'max-sm:block max-sm:[overflow-wrap:anywhere]';

/** The slug split for the stacked phone layout; the slash stays for screen readers and for the inline layout. */
const StackedSlug: React.FC<{ text: string }> = ({ text }) => {
  const slash = text.indexOf('/');
  if (slash <= 0 || slash === text.length - 1) return <span data-testid="repository-chip-name" className={narrowWrap}>{text}</span>;
  return <>
    <span data-testid="repository-chip-owner" className={`${narrowWrap} max-sm:text-slate-500`}>{text.slice(0, slash)}<span className="max-sm:sr-only">/</span></span>
    <span data-testid="repository-chip-name" className={narrowWrap}>{text.slice(slash + 1)}</span>
  </>;
};

/**
 * Shared monospace code chip for a repository identity: `owner/name`, preceded by the repository's
 * own icon when it has one. Repositories without a fetched icon render no mark rather than a wall of
 * repeated GitHub logos. The chip is inline so the background hugs the text instead of stretching
 * across its column; long names truncate inside it and stay reachable through the tooltip.
 *
 * Only the slug takes part in baseline alignment (the icon centres itself), so the chip reports the
 * baseline of its own text rather than its bottom border edge. A row that mixes the chip with plain
 * text can then align on baselines and have every item land on one straight line, padding and border
 * notwithstanding. Inside the chip nothing moves: the line box is still the slug's.
 *
 * With `stackOnNarrow` the chip may also shrink below its text's width on phones: the slug wraps inside
 * it (sized in rem so enlarged text scales it) rather than the whole chip overflowing its column.
 */
export const RepositoryChip: React.FC<RepositoryChipProps> = ({
  repository,
  label,
  iconPath,
  revision,
  className = '',
  title,
  icon,
  stackOnNarrow = false,
}) => (
  <span
    data-testid="repository-chip"
    className={`inline-flex max-w-full items-baseline gap-1.5 align-middle rounded-sm border border-slate-200 bg-slate-100 px-1.5 py-0.5 font-mono text-[12px] leading-4 text-slate-800 ${stackOnNarrow ? 'min-w-0 max-sm:text-xs max-sm:leading-4' : ''} ${className}`.replace(/\s+/g, ' ').trim()}
    title={title ?? repository}
  >
    {icon ?? (
      <RepositoryIcon
        repository={repository}
        iconPath={iconPath}
        revision={revision}
        className="h-3.5 w-3.5 self-center"
        fallback="none"
      />
    )}
    {stackOnNarrow
      ? <span className="min-w-0 font-mono sm:truncate"><StackedSlug text={label ?? repository} /></span>
      : <span className="truncate font-mono">{label ?? repository}</span>}
  </span>
);
