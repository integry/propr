import { createContext } from 'react';

export type StudioStage = 'draft' | 'review' | 'execute';

/**
 * The page's current phase, so each view's own title row can show the phase switcher
 * instead of the page stacking a separate stepper band above it.
 */
export const StudioStageContext = createContext<StudioStage | null>(null);
