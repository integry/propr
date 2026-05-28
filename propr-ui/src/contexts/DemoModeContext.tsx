import { createContext, useContext } from 'react';

export interface DemoModeContextValue {
  isDemoMode: boolean;
  isLoading: boolean;
}

export const DemoModeContext = createContext<DemoModeContextValue>({
  isDemoMode: false,
  isLoading: true,
});

export function useDemoMode(): DemoModeContextValue {
  return useContext(DemoModeContext);
}
