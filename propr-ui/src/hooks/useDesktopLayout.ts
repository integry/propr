import { useEffect, useState } from 'react';

const DESKTOP_MEDIA_QUERY = '(min-width: 640px)';

export function useDesktopLayout(): boolean {
  const getMatches = () => typeof window.matchMedia === 'function'
    ? window.matchMedia(DESKTOP_MEDIA_QUERY).matches
    : window.innerWidth >= 640;
  const [isDesktop, setIsDesktop] = useState(getMatches);

  useEffect(() => {
    if (typeof window.matchMedia === 'function') {
      const mediaQuery = window.matchMedia(DESKTOP_MEDIA_QUERY);
      const handleChange = (event: MediaQueryListEvent) => setIsDesktop(event.matches);
      setIsDesktop(mediaQuery.matches);
      mediaQuery.addEventListener('change', handleChange);
      return () => mediaQuery.removeEventListener('change', handleChange);
    }

    const handleResize = () => setIsDesktop(window.innerWidth >= 640);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  return isDesktop;
}
