import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

export const DESKTOP_NAVIGATION_EVENT = 'propr:desktop-navigation';

/** HashRouter uses pushState for links, which does not emit hashchange. */
export const DesktopNativeNavigationObserver = (): null => {
  const location = useLocation();
  useEffect(() => {
    window.dispatchEvent(new Event(DESKTOP_NAVIGATION_EVENT));
  }, [location]);
  return null;
};
