import { Granularity } from '../api/gitfixApi';

const STORAGE_KEY = 'plannerSettings';

export interface PlannerSettings {
  lastRepository: string | null;
  lastGranularity: Granularity;
  lastContextLevel: number;
}

const DEFAULT_SETTINGS: PlannerSettings = {
  lastRepository: null,
  lastGranularity: 'balanced',
  lastContextLevel: 50,
};

/**
 * Get planner settings from localStorage with graceful fallback to defaults
 */
export const getPlannerSettings = (): PlannerSettings => {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) {
      return DEFAULT_SETTINGS;
    }
    const parsed = JSON.parse(stored);
    // Validate and merge with defaults to ensure all fields exist
    return {
      lastRepository: typeof parsed.lastRepository === 'string' ? parsed.lastRepository : DEFAULT_SETTINGS.lastRepository,
      lastGranularity: ['single', 'balanced', 'granular'].includes(parsed.lastGranularity)
        ? parsed.lastGranularity
        : DEFAULT_SETTINGS.lastGranularity,
      lastContextLevel: typeof parsed.lastContextLevel === 'number' && parsed.lastContextLevel >= 10 && parsed.lastContextLevel <= 100
        ? parsed.lastContextLevel
        : DEFAULT_SETTINGS.lastContextLevel,
    };
  } catch {
    // JSON parsing error or localStorage access error
    return DEFAULT_SETTINGS;
  }
};

/**
 * Save partial planner settings to localStorage
 * Merges with existing settings
 */
export const savePlannerSettings = (settings: Partial<PlannerSettings>): void => {
  try {
    const current = getPlannerSettings();
    const updated = { ...current, ...settings };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
  } catch {
    // Silently fail if localStorage is not available
    console.warn('Failed to save planner settings to localStorage');
  }
};

/**
 * Clear all planner settings from localStorage
 */
export const clearPlannerSettings = (): void => {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Silently fail if localStorage is not available
  }
};
