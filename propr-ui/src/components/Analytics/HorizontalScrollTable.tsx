/**
 * A wide table that scrolls sideways inside a narrow pane, and says so.
 *
 * The table's first column stays pinned (cells marked with `PINNED_COLUMN`
 * from `pinnedColumn.ts`), so each row keeps its name while the figures slide
 * under it. While there is more to the right, a fade covers the right edge;
 * once the figures have moved under the pinned column, a shadow along its
 * edge shows they continue to the left. Neither edge shows when the table fits.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';

interface Edges { left: boolean; right: boolean }

export const HorizontalScrollTable: React.FC<{ children: React.ReactNode; testId?: string }> = ({ children, testId }) => {
  const scroller = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState<Edges>({ left: false, right: false });

  const measure = useCallback(() => {
    const element = scroller.current;
    if (!element) return;
    const left = element.scrollLeft > 0;
    const right = element.scrollLeft + element.clientWidth < element.scrollWidth - 1;
    setEdges(current => (current.left === left && current.right === right ? current : { left, right }));
  }, []);

  useEffect(() => {
    measure();
    const element = scroller.current;
    if (!element || typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    return () => observer.disconnect();
  }, [measure]);

  return (
    <div className="relative">
      <div
        ref={scroller}
        onScroll={measure}
        className="group/scroll overflow-x-auto"
        data-scrolled={edges.left}
        data-overflows-right={edges.right}
        data-testid={testId}
      >
        {children}
      </div>
      <div
        aria-hidden="true"
        className={`pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-white to-transparent transition-opacity ${edges.right ? 'opacity-100' : 'opacity-0'}`}
        data-testid={testId ? `${testId}-fade` : undefined}
      />
    </div>
  );
};
