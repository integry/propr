import { createContext, useContext } from 'react';
import type { DesktopConnectionResult, DesktopPlatform, DesktopProfile } from './types';
import type { DesktopBridge, DesktopNotificationScope } from '../../../apps/desktop/src/shared/contract';

export interface DesktopContextValue {
  isDesktop: true;
  platform: DesktopPlatform;
  profile: DesktopProfile;
  connection: DesktopConnectionResult;
  openProfileManager(): void;
  /** Resolves when authenticated requests for the active profile are ready. */
  authenticate(): Promise<void>;
  openConnectionHelp(): Promise<void>;
  retry(): void;
  notifications?: {
    bridge: NonNullable<DesktopBridge['notifications']>;
    scopeFor(userId: string): DesktopNotificationScope;
  };
  /** @internal Packaged acceptance signal owned by the committed connected renderer. */
  reportConnectedRendererReady?(): Promise<void>;
}

export const DesktopContext = createContext<DesktopContextValue | null>(null);

export const useDesktop = (): DesktopContextValue | null => useContext(DesktopContext);
