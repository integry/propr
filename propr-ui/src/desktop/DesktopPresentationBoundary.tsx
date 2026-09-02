import React, { useEffect, useState } from 'react';
import { DesktopDeepLinkInbox } from '../desktop-deep-link';
import { resolveDesktopAdapters } from './browserAdapters';
import { DesktopExperience } from './DesktopExperience';

interface DesktopPresentationBoundaryProps {
  desktop: React.ReactNode;
  fallback: React.ReactNode;
}

/** Keeps desktop detection at the application edge and leaves the route tree shared. */
export const DesktopPresentationBoundary: React.FC<DesktopPresentationBoundaryProps> = ({ desktop, fallback }) => {
  const adapters = useState(resolveDesktopAdapters)[0];
  const inbox = useState(() => new DesktopDeepLinkInbox())[0];

  useEffect(() => {
    if (!adapters) return;
    return adapters.app.onDeepLink(value => inbox.receive(value));
  }, [adapters, inbox]);

  return adapters ? <DesktopExperience adapters={adapters} deepLinks={inbox}>{desktop}</DesktopExperience> : fallback;
};
