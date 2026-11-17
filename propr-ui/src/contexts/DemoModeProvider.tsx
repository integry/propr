import React, { useEffect, useMemo, useState } from 'react';
import { getDemoModeStatus } from '../api/proprApi';
import { setDemoModeRequestGate } from '../api/demoModeRequestGate';
import { DemoModeContext } from './DemoModeContext';

export const DemoModeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [isDemoMode, setIsDemoMode] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    getDemoModeStatus()
      .then((status) => {
        if (cancelled) return;
        // Before the re-render that mounts the pages, so their first reads are already gated.
        setDemoModeRequestGate(status.demoMode);
        setIsDemoMode(status.demoMode);
      })
      .catch(() => {
        if (cancelled) return;
        setDemoModeRequestGate(false);
        setIsDemoMode(false);
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
