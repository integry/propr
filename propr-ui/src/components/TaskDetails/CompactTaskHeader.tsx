import React from 'react';
import ContextStrip from './ContextStrip';
import ActionBar from './ActionBar';
import ProgressBar from './ProgressBar';

export type MobileHeaderProps = {
  contextStripProps: React.ComponentProps<typeof ContextStrip>;
  actionBarProps: React.ComponentProps<typeof ActionBar>;
  todos: React.ComponentProps<typeof ProgressBar>['todos'];
};

/** Height of the compact bar; sections pin their own headers just below it. */
export const MOBILE_COMPACT_BAR_HEIGHT = 44;

/**
 * One fixed-height line: the pull request and the task's title on the left,
 * the overflow (and Stop, while the task works) on the right; the overflow
 * opens as a bottom action sheet.
 */
export const CompactHeaderLine: React.FC<Omit<MobileHeaderProps, 'todos'> & { children?: React.ReactNode }> = ({ contextStripProps, actionBarProps, children }) => (
  <div className="flex items-center justify-between gap-2 px-3" style={{ height: MOBILE_COMPACT_BAR_HEIGHT - 1 }}>
    {/* Only the left side clips, so the 44px overflow button keeps its full touch target. */}
    <div className="flex h-full min-w-0 flex-1 items-center overflow-hidden">
      <ContextStrip {...contextStripProps} mobileCompact={true} />
    </div>
    <ActionBar {...actionBarProps} compact={true} />
    {children}
  </div>
);

/**
 * The task header of a short window (a phone in landscape, a short desktop window): the compact line
 * in place of the full header, so the timeline under it opens with room to read.
 */
export const ShortTaskHeader: React.FC<MobileHeaderProps & { visible: boolean; paneControls?: React.ReactNode }> = ({ visible, contextStripProps, actionBarProps, todos, paneControls }) => {
  if (!visible) return null;
  return (
    <header data-testid="task-short-header" className="hidden sm:block flex-shrink-0 border-b border-slate-200 bg-white">
      <CompactHeaderLine contextStripProps={contextStripProps} actionBarProps={actionBarProps}>
        {paneControls && <div className="flex flex-none items-center gap-0.5">{paneControls}</div>}
      </CompactHeaderLine>
      <ProgressBar todos={todos} />
    </header>
  );
};
