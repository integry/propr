export type PackagedAcceptanceSetupSurface = 'prerequisites' | 'error' | 'completion';

export const packagedAcceptanceSetupSurface = (): PackagedAcceptanceSetupSurface | null => {
  if (typeof window === 'undefined'
    || typeof window.__PROPR_PACKAGED_ACCEPTANCE__ !== 'object'
    || window.__PROPR_PACKAGED_ACCEPTANCE__ === null) return null;
  if (window.__PROPR_PACKAGED_ACCEPTANCE_SCENARIO__ === 'setup-error') return 'error';
  if (window.__PROPR_PACKAGED_ACCEPTANCE_SCENARIO__ === 'setup-complete') return 'completion';
  return 'prerequisites';
};
