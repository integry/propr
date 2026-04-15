import { useEffect, useRef } from 'react';

export function useClickOutsideCollapse(
  collapsed: boolean,
  onCollapse: () => void,
) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (collapsed) return;

    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (ref.current && !ref.current.contains(target)) {
        onCollapse();
      }
    };

    const timeoutId = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
    }, 100);

    return () => {
      clearTimeout(timeoutId);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [collapsed, onCollapse]);

  return ref;
}
