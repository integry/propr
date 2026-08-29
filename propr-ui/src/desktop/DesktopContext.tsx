import { createContext, useContext } from 'react';
import type { DesktopConnectionResult, DesktopPlatform, DesktopProfile } from './types';

export interface DesktopContextValue {
  isDesktop: true;
  platform: DesktopPlatform;
  profile: DesktopProfile;
  connection: DesktopConnectionResult;
  openProfileManager(): void;
  authenticate(): Promise<void>;
  openConnectionHelp(): Promise<void>;
  retry(): void;
}

export const DesktopContext = createContext<DesktopContextValue | null>(null);

export const useDesktop = (): DesktopContextValue | null => useContext(DesktopContext);
