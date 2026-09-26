import { useEffect, useState } from 'react';

// Match the app shell: below `md` the global header/sidebar are replaced by
// mobile navigation, so split-pane pages should keep using their mobile UI too.
const DESKTOP_BREAKPOINT_PX = 768;
const DESKTOP_MEDIA_QUERY = `(min-width: ${DESKTOP_BREAKPOINT_PX}px)`;

export function useDesktopLayout(): boolean {
  const getMatches = () => typeof window.matchMedia === 'function'
    ? window.matchMedia(DESKTOP_MEDIA_QUERY).matches
    : window.innerWidth >= DESKTOP_BREAKPOINT_PX;
  const [isDesktop, setIsDesktop] = useState(getMatches);

  useEffect(() => {
    if (typeof window.matchMedia === 'function') {
      const mediaQuery = window.matchMedia(DESKTOP_MEDIA_QUERY);
      const handleChange = (event: MediaQueryListEvent) => setIsDesktop(event.matches);
      setIsDesktop(mediaQuery.matches);
      mediaQuery.addEventListener('change', handleChange);
      return () => mediaQuery.removeEventListener('change', handleChange);
    }

    const handleResize = () => setIsDesktop(window.innerWidth >= DESKTOP_BREAKPOINT_PX);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  return isDesktop;
}
