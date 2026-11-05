/**
 * The one loading treatment for a list.
 *
 * While a section waits for its first read it draws grey placeholders shaped
 * like the content about to land: rows for a feed, columns for a table, blocks
 * for a console. Placeholders are `bg-slate-100` on the white canvas with the
 * same `rounded-sm` corner as the repository chip, and they carry no rules of
 * their own — rules are spent on pane edges, not on rows that do not exist yet.
 *
 * A skeleton is only ever the first read. Once a section has rows, a refresh
 * keeps them on screen and swaps them silently when the next read lands; no
 * list announces "Refreshing…".
 */

import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';

const PULSE = 'animate-pulse motion-reduce:animate-none';

/** One placeholder. Hidden from assistive technology: the container speaks. */
export const SkeletonBlock: React.FC<{
  className?: string;
  style?: React.CSSProperties;
  /** Pulse on its own, for a lone placeholder with no skeleton container around it. */
  pulse?: boolean;
}> = ({ className = '', style, pulse = false }) => (
  <div
    aria-hidden="true"
    data-skeleton-block=""
    className={`rounded-sm bg-slate-100 ${pulse ? PULSE : ''} ${className}`.replace(/\s+/g, ' ').trim()}
    style={style}
  />
);

export type ListSkeletonLayout = 'row' | 'table' | 'card' | 'block';

export interface ListSkeletonProps {
  /** Number of placeholder rows (or blocks for `card` and `block`). */
  rows?: number;
  layout?: ListSkeletonLayout;
  /** Column count for `layout="table"`. The first column is the wide one. */
  columns?: number;
  /** What a screen reader hears, once: "Loading goals…". */
  label: string;
  className?: string;
  'data-testid'?: string;
}

const RowShapes: React.FC<{ rows: number }> = ({ rows }) => (
  <div className="space-y-2">
    {Array.from({ length: rows }, (_, index) => <SkeletonBlock key={index} className="h-10" />)}
  </div>
);

/**
 * Column shapes for a table. The first column holds the title and gets the
 * room; the rest are even. The template is inline because the column count is
 * a prop and Tailwind cannot see a class built at runtime.
 */
const ColumnShapes: React.FC<{ rows: number; columns: number }> = ({ rows, columns }) => {
  const cells = Math.max(1, columns);
  const gridTemplateColumns = cells === 1
    ? 'minmax(0,1fr)'
    : `minmax(0,2.5fr) repeat(${cells - 1}, minmax(0,1fr))`;
  return (
    <div>
      {Array.from({ length: rows }, (_, row) => (
        <div key={row} className="grid items-center gap-x-4 py-2.5" style={{ gridTemplateColumns }}>
          {Array.from({ length: cells }, (_, cell) => (
            <SkeletonBlock key={cell} className={cell === 0 ? 'h-5' : 'h-4'} />
          ))}
        </div>
      ))}
    </div>
  );
};

/** A console: a title, a metadata line, then the blocks it is made of. */
const CardShapes: React.FC<{ rows: number }> = ({ rows }) => (
  <div className="space-y-3">
    <SkeletonBlock className="h-7 w-2/5 max-w-md" />
    <SkeletonBlock className="h-4 w-3/5 max-w-lg" />
    <div className="space-y-3 pt-2">
      {Array.from({ length: rows }, (_, index) => <SkeletonBlock key={index} className="h-24" />)}
    </div>
  </div>
);

const BlockShapes: React.FC<{ rows: number }> = ({ rows }) => (
  <div className="space-y-3">
    {Array.from({ length: rows }, (_, index) => <SkeletonBlock key={index} className="h-32" />)}
  </div>
);

/**
 * Registers a waiting skeleton with the page and returns its release. Null
 * outside a `PageLoadingStatus`, where every skeleton speaks for itself.
 */
const PageLoadingContext = createContext<(() => () => void) | null>(null);

/**
 * One voice for a page of skeletons.
 *
 * A page that draws several sections at once — the dashboard's panes, the
 * analytics widgets — would otherwise put one live region per section on
 * screen, and a screen reader would hear "Loading…" once per pane. Inside this
 * provider every skeleton stays silent and the page says `label` once, for as
 * long as any of them is still waiting. The region is always mounted so the
 * announcement is a text change in a region the reader already knows about.
 */
export const PageLoadingStatus: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => {
  const [pending, setPending] = useState(0);
  const register = useCallback(() => {
    setPending(count => count + 1);
    return () => setPending(count => count - 1);
  }, []);
  return (
    <PageLoadingContext.Provider value={register}>
      <div role="status" className="sr-only" data-testid="page-loading-status">{pending > 0 ? label : ''}</div>
      {children}
    </PageLoadingContext.Provider>
  );
};

/**
 * The pulsing container a skeleton draws inside.
 *
 * On its own it is a busy `role="status"` with one `sr-only` label. Inside a
 * `PageLoadingStatus` it drops both and reports to the page instead, so a
 * screen of widgets announces once rather than once per widget.
 */
export const SkeletonRegion: React.FC<{
  label: string;
  className?: string;
  children: React.ReactNode;
  'data-testid'?: string;
  'data-skeleton-layout'?: string;
}> = ({ label, className = '', children, ...rest }) => {
  const register = useContext(PageLoadingContext);
  useEffect(() => register?.(), [register]);
  const classes = `${PULSE} ${className}`.trim();
  if (register) {
    return <div aria-busy="true" className={classes} {...rest}>{children}</div>;
  }
  return (
    <div role="status" aria-busy="true" className={classes} {...rest}>
      <span className="sr-only">{label}</span>
      {children}
    </div>
  );
};

/**
 * The accessible loading container every list uses.
 *
 * Exactly one `role="status"` and one `sr-only` label per skeleton, or none
 * inside a `PageLoadingStatus`. A table draws rows below `lg` and columns from
 * `lg` up inside that same element, so the responsive variants never announce
 * twice.
 */
export const ListSkeleton: React.FC<ListSkeletonProps> = ({
  rows = 3,
  layout = 'row',
  columns = 4,
  label,
  className = '',
  'data-testid': testId,
}) => (
  <SkeletonRegion label={label} className={className} data-testid={testId} data-skeleton-layout={layout}>
    <div aria-hidden="true">
      {layout === 'table' ? (
        <>
          <div className="lg:hidden"><RowShapes rows={rows} /></div>
          <div className="hidden lg:block"><ColumnShapes rows={rows} columns={columns} /></div>
        </>
      ) : layout === 'card' ? (
        <CardShapes rows={rows} />
      ) : layout === 'block' ? (
        <BlockShapes rows={rows} />
      ) : (
        <RowShapes rows={rows} />
      )}
    </div>
  </SkeletonRegion>
);
