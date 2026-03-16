import { useState, useEffect } from 'react';

/**
 * Hook to detect if the current viewport is mobile-sized.
 * Uses 640px as the breakpoint (matching Tailwind's 'sm' breakpoint).
 * @returns true if viewport width is less than 640px
 */
export const useIsMobile = (breakpoint: number = 640): boolean => {
  const [isMobile, setIsMobile] = useState(() => {
    if (typeof window !== 'undefined') {
      return window.innerWidth < breakpoint;
    }
    return false;
  });

  useEffect(() => {
    const checkMobile = () => {
      setIsMobile(window.innerWidth < breakpoint);
    };

    // Check on mount
    checkMobile();

    // Listen for resize events
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, [breakpoint]);

  return isMobile;
};

export default useIsMobile;
