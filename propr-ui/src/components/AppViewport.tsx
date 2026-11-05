import React from 'react';
import { appViewportHeight } from './appViewportHeight';

interface AppViewportProps {
  /** Fixed banner rendered above the app; `offset` reserves its height. */
  banner?: React.ReactNode;
  offset?: boolean;
  children: React.ReactNode;
}

/** The app's outermost frame: fills the browser viewport or the desktop window. */
export const AppViewport: React.FC<AppViewportProps> = ({ banner, offset = false, children }) => (
  <div className={`flex ${appViewportHeight()} flex-col ${offset ? 'pt-9' : ''}`}>
    {banner}
    <div className="min-h-0 flex-1">{children}</div>
  </div>
);
