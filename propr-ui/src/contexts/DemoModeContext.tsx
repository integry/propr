import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { getDemoModeStatus, setDemoModeEnabled } from '../api/proprApi';

interface DemoModeContextValue {
  isDemoMode: boolean;
  isLoading: boolean;
}

const DemoModeContext = createContext<DemoModeContextValue>({
  isDemoMode: false,
  isLoading: true,
});

export const DemoModeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [isDemoMode, setIsDemoMode] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    getDemoModeStatus()
      .then((status) => {
        if (cancelled) return;
        setIsDemoMode(status.demoMode);
        setDemoModeEnabled(status.demoMode);
      })
      .catch(() => {
        if (cancelled) return;
        setIsDemoMode(false);
        setDemoModeEnabled(false);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const value = useMemo(() => ({ isDemoMode, isLoading }), [isDemoMode, isLoading]);

  return (
    <DemoModeContext.Provider value={value}>
      {children}
    </DemoModeContext.Provider>
  );
};

export function useDemoMode(): DemoModeContextValue {
  return useContext(DemoModeContext);
}
