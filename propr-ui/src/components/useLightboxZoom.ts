import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 4;
export const DOUBLE_TAP_ZOOM = 2.5;
const STEP_FACTOR = 1.5;
const MOVE_THRESHOLD_PX = 6;
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_DISTANCE_PX = 30;

interface Point { x: number; y: number }
export interface ZoomView { scale: number; x: number; y: number }

type Gesture =
  | { kind: 'pan'; start: Point; origin: ZoomView }
  | { kind: 'pinch'; distance: number; midpoint: Point; origin: ZoomView };

const RESTING: ZoomView = { scale: MIN_ZOOM, x: 0, y: 0 };
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const midpoint = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/**
 * Pointer-event zoom/pan state machine for the preview lightbox.
 * Coordinates are relative to the stage centre, matching a `translate() scale()` transform with a centred origin.
 */
export function useLightboxZoom({ stageRef, contentRef, resetKey }: {
  stageRef: RefObject<HTMLElement | null>;
  contentRef: RefObject<HTMLElement | null>;
  resetKey: unknown;
}) {
  const [view, setView] = useState<ZoomView>(RESTING);
  const viewRef = useRef<ZoomView>(RESTING);
  const pointers = useRef(new Map<number, Point>());
  const downAt = useRef(new Map<number, Point>());
  const gesture = useRef<Gesture | null>(null);
  const moved = useRef(false);
  const lastTap = useRef<{ at: number; point: Point } | null>(null);
  const lastPointerType = useRef<string | null>(null);

  const toStage = useCallback((clientX: number, clientY: number): Point => {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return { x: clientX - rect.left - rect.width / 2, y: clientY - rect.top - rect.height / 2 };
  }, [stageRef]);

  /** Keep the zoomed content covering the stage; unmeasurable layouts (not yet loaded) stay unbounded. */
  const bounded = useCallback((next: ZoomView): ZoomView => {
    const scale = clamp(next.scale, MIN_ZOOM, MAX_ZOOM);
    if (scale <= MIN_ZOOM) return RESTING;
    const stage = stageRef.current;
    const content = contentRef.current;
    const limit = (contentSize = 0, stageSize = 0) => contentSize && stageSize ? Math.max(0, (contentSize * scale - stageSize) / 2) : Infinity;
    const maxX = limit(content?.offsetWidth, stage?.clientWidth);
    const maxY = limit(content?.offsetHeight, stage?.clientHeight);
    return { scale, x: clamp(next.x, -maxX, maxX), y: clamp(next.y, -maxY, maxY) };
  }, [contentRef, stageRef]);

  const commit = useCallback((next: ZoomView) => {
    const value = bounded(next);
    viewRef.current = value;
    setView(value);
  }, [bounded]);

  /** Scale around `anchor` so the content point under it stays put. */
  const zoomTo = useCallback((scale: number, anchor: Point = { x: 0, y: 0 }, from: ZoomView = viewRef.current) => {
    const next = clamp(scale, MIN_ZOOM, MAX_ZOOM);
    const ratio = next / from.scale;
    commit({ scale: next, x: anchor.x - (anchor.x - from.x) * ratio, y: anchor.y - (anchor.y - from.y) * ratio });
  }, [commit]);

  const reset = useCallback(() => commit(RESTING), [commit]);
  const zoomIn = useCallback(() => zoomTo(viewRef.current.scale * STEP_FACTOR), [zoomTo]);
  const zoomOut = useCallback(() => zoomTo(viewRef.current.scale / STEP_FACTOR), [zoomTo]);
  const toggleAt = useCallback((clientX: number, clientY: number) => {
    if (viewRef.current.scale > MIN_ZOOM) reset();
    else zoomTo(DOUBLE_TAP_ZOOM, toStage(clientX, clientY));
  }, [reset, toStage, zoomTo]);

  useEffect(() => {
    pointers.current.clear();
    downAt.current.clear();
    gesture.current = null;
    lastTap.current = null;
    viewRef.current = RESTING;
    setView(RESTING);
  }, [resetKey]);

  /** Re-derive the gesture from whichever pointers remain, so lifting one finger mid-pinch continues as a pan. */
  const beginGesture = useCallback(() => {
    const active = [...pointers.current.values()];
    const origin = viewRef.current;
    if (active.length >= 2) gesture.current = { kind: 'pinch', distance: distance(active[0], active[1]) || 1, midpoint: midpoint(active[0], active[1]), origin };
    else if (active.length === 1 && origin.scale > MIN_ZOOM) gesture.current = { kind: 'pan', start: active[0], origin };
    else gesture.current = null;
  }, []);

  // No pointer capture: Chrome retargets the follow-up click to the capturing stage, which would read as a backdrop click.
  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if ((event.target as Element).closest?.('button, a')) return;
    lastPointerType.current = event.pointerType;
    if (!pointers.current.size) moved.current = false;
    const point = toStage(event.clientX, event.clientY);
    pointers.current.set(event.pointerId, point);
    downAt.current.set(event.pointerId, point);
    beginGesture();
  }, [beginGesture, toStage]);

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (!pointers.current.has(event.pointerId)) return;
    const point = toStage(event.clientX, event.clientY);
    pointers.current.set(event.pointerId, point);
    const start = downAt.current.get(event.pointerId);
    if (start && distance(start, point) > MOVE_THRESHOLD_PX) moved.current = true;
    const current = gesture.current;
    if (!current) return;
    if (current.kind === 'pan') {
      commit({ ...current.origin, x: current.origin.x + point.x - current.start.x, y: current.origin.y + point.y - current.start.y });
      return;
    }
    const [a, b] = [...pointers.current.values()];
    if (!a || !b) return;
    const { origin } = current;
    const scale = clamp(origin.scale * distance(a, b) / current.distance, MIN_ZOOM, MAX_ZOOM);
    const centre = midpoint(a, b);
    // The content point that sat under the starting midpoint follows the fingers: zoom and two-finger pan at once.
    const localX = (current.midpoint.x - origin.x) / origin.scale;
    const localY = (current.midpoint.y - origin.y) / origin.scale;
    moved.current = true;
    commit({ scale, x: centre.x - localX * scale, y: centre.y - localY * scale });
  }, [commit, toStage]);

  const detectDoubleTap = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (event.pointerType !== 'touch' || moved.current || pointers.current.size) return;
    const point = toStage(event.clientX, event.clientY);
    const previous = lastTap.current;
    if (previous && event.timeStamp - previous.at <= DOUBLE_TAP_MS && distance(previous.point, point) <= DOUBLE_TAP_DISTANCE_PX) {
      lastTap.current = null;
      toggleAt(event.clientX, event.clientY);
      return;
    }
    lastTap.current = { at: event.timeStamp, point };
  }, [toStage, toggleAt]);

  const onPointerUp = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (!pointers.current.delete(event.pointerId)) return;
    downAt.current.delete(event.pointerId);
    beginGesture();
    if (event.type === 'pointerup') detectDoubleTap(event);
  }, [beginGesture, detectDoubleTap]);

  /** Touch double-taps are recognised from pointer events; the synthesised dblclick would toggle twice. */
  const onDoubleClick = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    if (lastPointerType.current === 'touch') return;
    toggleAt(event.clientX, event.clientY);
  }, [toggleAt]);

  /** Native, non-passive listener: Ctrl/⌘ + wheel (trackpad pinch) zooms at the cursor, plain wheel pans when zoomed. */
  const onWheel = useCallback((event: WheelEvent) => {
    event.preventDefault();
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
    if (event.ctrlKey || event.metaKey) {
      zoomTo(viewRef.current.scale * Math.exp(-event.deltaY * unit * 0.01), toStage(event.clientX, event.clientY));
      return;
    }
    const current = viewRef.current;
    if (current.scale > MIN_ZOOM) commit({ ...current, x: current.x - event.deltaX * unit, y: current.y - event.deltaY * unit });
  }, [commit, toStage, zoomTo]);

  /** True when the click that just fired ended a pan or pinch, so it must not dismiss the lightbox. */
  const consumeGestureClick = useCallback(() => {
    const wasGesture = moved.current;
    moved.current = false;
    return wasGesture;
  }, []);

  return {
    view,
    transform: `translate3d(${view.x}px, ${view.y}px, 0) scale(${view.scale})`,
    zoomIn,
    zoomOut,
    reset,
    onWheel,
    consumeGestureClick,
    handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp, onPointerLeave: onPointerUp, onDoubleClick },
  };
}
