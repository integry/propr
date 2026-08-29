import React, { useState } from 'react';
import { resolveDesktopAdapters } from './browserAdapters';
import { DesktopExperience } from './DesktopExperience';

interface DesktopPresentationBoundaryProps {
  desktop: React.ReactNode;
  fallback: React.ReactNode;
}

/** Keeps desktop detection at the application edge and leaves the route tree shared. */
export const DesktopPresentationBoundary: React.FC<DesktopPresentationBoundaryProps> = ({ desktop, fallback }) => {
  const adapters = useState(resolveDesktopAdapters)[0];
  return adapters ? <DesktopExperience adapters={adapters}>{desktop}</DesktopExperience> : fallback;
};

