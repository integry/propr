import { useEffect, useRef } from 'react';

/**
 * Collapses the drawer on a click outside it. Clicks inside an element carrying `ignoreAttribute`
 * (a control that opens or closes the drawer itself) are left to that control.
 */
export function useClickOutsideCollapse(
  collapsed: boolean,
  onCollapse: () => void,
  ignoreAttribute?: string,
) {
  const ref = useRef<HTMLDivElement>(null);
  const onCollapseRef = useRef(onCollapse);
  onCollapseRef.current = onCollapse;

  useEffect(() => {
    if (collapsed) return;

    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (ignoreAttribute && target instanceof Element && target.closest(`[${ignoreAttribute}]`)) return;
      if (ref.current && !ref.current.contains(target)) {
        onCollapseRef.current();
      }
    };

    const timeoutId = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
    }, 100);

    return () => {
      clearTimeout(timeoutId);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [collapsed, ignoreAttribute]);

  return ref;
}
