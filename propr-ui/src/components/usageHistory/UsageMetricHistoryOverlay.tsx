/**
 * The sidebar's per-metric usage history: hover a metric row (or tap it on a
 * touch screen) to see how that quota moved over its last two periods - ten
 * hours for a five-hour session, two weeks for a weekly limit.
 *
 * Hover opens after a short intent delay, so sweeping the pointer down the
 * sidebar does not fire a request per row, and the overlay stays open while
 * the pointer travels from the row into it. A click or tap pins it open until
 * Escape, the close button, a second tap or a tap outside. On a wide screen it
 * sits beside the sidebar; on a narrow one it spans the screen just above or
 * below the row, so it never covers the row it describes.
 */

import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { getProviderDisplayName, getTextColor, type UsageMetric } from '../agentTankMetrics';
import { SkeletonBlock } from '../ui/Skeleton';
import UsageMetricHistoryChart from './UsageMetricHistoryChart';
import { currentPeriodStart, twoPeriodWindow } from './usageHistoryModel';
import { useDemoMode } from '../../contexts/DemoModeContext';
import { useUsageHistoryDisabled, useUsageMetricHistory, type UsageMetricHistoryState } from './useUsageMetricHistory';

export const HOVER_OPEN_DELAY_MS = 250;
const HOVER_CLOSE_GRACE_MS = 150;
const OVERLAY_WIDTH = 300;
const VIEWPORT_MARGIN = 8;
const ANCHOR_GAP = 12;
/** Below this width the overlay spans the screen instead of sitting beside the row. */
const NARROW_VIEWPORT = 640;

function rangeLabel(periodMs: number): string {
  const hours = (2 * periodMs) / 3_600_000;
  return hours <= 48 ? `Last ${Math.round(hours)} hours` : `Last ${Math.round(hours / 24)} days`;
}

interface Position {
  top: number;
  left: number;
  width: number;
}

function placeOverlay(anchor: DOMRect, height: number): Position {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  if (vw < NARROW_VIEWPORT) {
    const width = vw - 2 * VIEWPORT_MARGIN;
    const below = anchor.bottom + 6;
    const top = below + height <= vh - VIEWPORT_MARGIN ? below : Math.max(VIEWPORT_MARGIN, anchor.top - 6 - height);
    return { top, left: VIEWPORT_MARGIN, width };
  }
  let left = anchor.right + ANCHOR_GAP;
  if (left + OVERLAY_WIDTH > vw - VIEWPORT_MARGIN) left = anchor.left - ANCHOR_GAP - OVERLAY_WIDTH;
  left = Math.min(Math.max(VIEWPORT_MARGIN, left), vw - VIEWPORT_MARGIN - OVERLAY_WIDTH);
  const centered = anchor.top + anchor.height / 2 - height / 2;
  const top = Math.min(Math.max(VIEWPORT_MARGIN, centered), Math.max(VIEWPORT_MARGIN, vh - VIEWPORT_MARGIN - height));
  return { top, left, width: OVERLAY_WIDTH };
}

const OverlayBody: React.FC<{ state: UsageMetricHistoryState | null; metric: UsageMetric }> = ({ state, metric }) => {
  if (!state || state.status === 'loading') {
    return <SkeletonBlock className="h-[132px] w-full" />;
  }
  if (state.status === 'error') {
    return <p className="py-6 text-center text-xs text-red-600">{state.message}</p>;
  }
  if (!state.enabled) {
    return <p className="py-6 text-center text-xs text-slate-500">Usage history is not available.</p>;
  }
  const points = state.series?.points ?? [];
  if (points.length < 2) {
    return (
      <p className="py-6 text-center text-xs text-slate-500">
        Not enough history yet. ProPR records a point each time it reads Agent Tank.
      </p>
    );
  }
  return (
    <UsageMetricHistoryChart
      points={points}
      since={state.since}
      until={state.until}
      periodStart={currentPeriodStart(state, metric.resetsIn)}
      currentPercent={metric.percent}
    />
  );
};

interface OverlayPanelProps {
  id: string;
  title: string;
  metric: UsageMetric;
  state: UsageMetricHistoryState | null;
  pinned: boolean;
  position: Position | null;
  onClose: () => void;
  onPointerEnter: (event: React.PointerEvent) => void;
  onPointerLeave: (event: React.PointerEvent) => void;
}

const OverlayPanel = React.forwardRef<HTMLDivElement, OverlayPanelProps>(({
  id, title, metric, state, pinned, position, onClose, onPointerEnter, onPointerLeave,
}, ref) => (
  <div
    ref={ref}
    id={id}
    role="dialog"
    aria-label={`${title} usage history`}
    data-testid="usage-metric-history-overlay"
    className="fixed z-[70] rounded-lg border border-slate-200 bg-white p-3 shadow-lg"
    style={{
      top: position?.top ?? -9999,
      left: position?.left ?? -9999,
      width: position?.width ?? OVERLAY_WIDTH,
    }}
    onPointerEnter={onPointerEnter}
    onPointerLeave={onPointerLeave}
  >
    <div className="mb-2 flex items-start justify-between gap-2">
      <div className="min-w-0">
        <div className="truncate text-xs font-semibold text-slate-800" title={title}>{title}</div>
        <div className="text-[11px] text-slate-500">
          {rangeLabel(state?.periodMs ?? twoPeriodWindow(metric.cycle).periodMs)}
          {metric.resetsIn ? ` · resets in ${metric.resetsIn}` : ''}
        </div>
      </div>
      <div className="flex flex-none items-center gap-1">
        <span className={`text-sm font-semibold ${getTextColor(metric.percent)}`}>{metric.percent}%</span>
        {pinned && (
          <button
            type="button"
            onClick={onClose}
            className="-mr-1 rounded p-1 text-slate-400 hover:text-slate-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-slate-400"
            aria-label="Close usage history"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
    <OverlayBody state={state} metric={metric} />
  </div>
));
OverlayPanel.displayName = 'OverlayPanel';

interface UsageMetricHistoryTriggerProps {
  agent: string;
  metric: UsageMetric;
  children: React.ReactNode;
  className?: string;
}

/** Wraps a metric row so it opens that metric's history; inert without a history key or in demo mode. */
export const UsageMetricHistoryTrigger: React.FC<UsageMetricHistoryTriggerProps> = ({
  agent, metric, children, className = '',
}) => {
  const { isDemoMode } = useDemoMode();
  // Demo viewers see the synthetic usage feed but may not read real history.
  const historyKey = isDemoMode ? undefined : metric.historyKey;
  const historyDisabled = useUsageHistoryDisabled();
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [position, setPosition] = useState<Position | null>(null);
  const anchorRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const openTimer = useRef<number | undefined>(undefined);
  const closeTimer = useRef<number | undefined>(undefined);
  const dialogId = useId();
  const state = useUsageMetricHistory(agent, historyKey ?? '', metric.cycle, open && !!historyKey);

  const clearTimers = useCallback(() => {
    window.clearTimeout(openTimer.current);
    window.clearTimeout(closeTimer.current);
  }, []);
  const close = useCallback(() => {
    clearTimers();
    setOpen(false);
    setPinned(false);
  }, [clearTimers]);

  useEffect(() => clearTimers, [clearTimers]);

  const reposition = useCallback(() => {
    if (!anchorRef.current) return;
    const height = overlayRef.current?.offsetHeight ?? 200;
    setPosition(placeOverlay(anchorRef.current.getBoundingClientRect(), height));
  }, []);

  useLayoutEffect(() => {
    if (!open) return undefined;
    reposition();
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [open, reposition, state?.status]);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (anchorRef.current?.contains(target) || overlayRef.current?.contains(target)) return;
      close();
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open, close]);

  // An overlay that is already open keeps showing why history is unavailable.
  if (!historyKey || (historyDisabled && !open)) return <div className={className}>{children}</div>;

  const hoverIn = (event: React.PointerEvent) => {
    if (event.pointerType !== 'mouse') return;
    window.clearTimeout(closeTimer.current);
    if (open) return;
    openTimer.current = window.setTimeout(() => setOpen(true), HOVER_OPEN_DELAY_MS);
  };
  const hoverOut = (event: React.PointerEvent) => {
    if (event.pointerType !== 'mouse') return;
    window.clearTimeout(openTimer.current);
    if (pinned) return;
    closeTimer.current = window.setTimeout(() => setOpen(false), HOVER_CLOSE_GRACE_MS);
  };
  const toggle = () => {
    clearTimers();
    if (open && pinned) {
      close();
      return;
    }
    setOpen(true);
    setPinned(true);
  };

  const title = `${getProviderDisplayName(agent)} · ${metric.title ?? metric.label}`;

  return (
    <>
      <div
        ref={anchorRef}
        role="button"
        tabIndex={0}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? dialogId : undefined}
        // The row's own text ("Session 17%") names the button; the popup
        // relationship says it opens the history.
        aria-description="Show usage history"
        className={`cursor-pointer rounded hover:bg-slate-900/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-slate-400 ${className}`}
        onPointerEnter={hoverIn}
        onPointerLeave={hoverOut}
        onClick={toggle}
        onKeyDown={event => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            toggle();
          }
        }}
      >
        {children}
      </div>
      {open && createPortal(
        <OverlayPanel
          ref={overlayRef}
          id={dialogId}
          title={title}
          metric={metric}
          state={state}
          pinned={pinned}
          position={position}
          onClose={close}
          onPointerEnter={event => {
            if (event.pointerType === 'mouse') window.clearTimeout(closeTimer.current);
          }}
          onPointerLeave={hoverOut}
        />,
        document.body,
      )}
    </>
  );
};
