// Public ProPR version surfaced to the hosted UI via `/api/compatibility`. This
// must track the release version. The shared package is bundled for the browser
// (no fs/JSON-import of package.json available within rootDir), so it is kept as
// a constant rather than read from package.json at runtime. A release bump that
// updates packages/shared/package.json or docker/launcher/manifest.json but
// forgets this constant is caught by the drift test in
// test/orchestratorProprUrlsDrift.test.ts, which asserts all three agree.
export const PROPR_VERSION = '0.8.6';

// Bump this only when the API/UI contract changes in a way the hosted UI must
// account for. Patch releases that do not change the browser-facing contract can
// keep the same compatibility version.
export const PROPR_API_COMPATIBILITY = '2026-06-27';
export const PROPR_UI_COMPATIBILITY = PROPR_API_COMPATIBILITY;
export const PROPR_UI_SUPPORTED_API_COMPATIBILITY = [PROPR_API_COMPATIBILITY] as const;

export interface ProprCompatibilityMetadata {
  version: string;
  apiCompatibility: string;
  uiCompatibility: string;
}

export interface ProprApiCompatibilityInput {
  apiCompatibility?: string | null;
  version?: string | null;
}

export type ProprApiCompatibilityResult =
  | {
      compatible: true;
      apiCompatibility: string;
      apiVersion: string | null;
    }
  | {
      compatible: false;
      apiCompatibility: string | null;
      apiVersion: string | null;
      reason: 'missing' | 'too_old' | 'too_new' | 'unsupported';
      message: string;
    };

export function getProprCompatibilityMetadata(): ProprCompatibilityMetadata {
  return {
    version: PROPR_VERSION,
    apiCompatibility: PROPR_API_COMPATIBILITY,
    uiCompatibility: PROPR_UI_COMPATIBILITY,
  };
}

export function evaluateProprApiCompatibility(
  input: ProprApiCompatibilityInput
): ProprApiCompatibilityResult {
  const apiCompatibility = input.apiCompatibility?.trim() || null;
  const apiVersion = input.version?.trim() || null;

  if (!apiCompatibility) {
    return {
      compatible: false,
      apiCompatibility,
      apiVersion,
      reason: 'missing',
      message: 'This ProPR instance does not publish API compatibility metadata. Update the local ProPR stack before using the hosted UI.',
    };
  }

  if (PROPR_UI_SUPPORTED_API_COMPATIBILITY.includes(apiCompatibility as typeof PROPR_UI_SUPPORTED_API_COMPATIBILITY[number])) {
    return { compatible: true, apiCompatibility, apiVersion };
  }

  // PROPR_UI_SUPPORTED_API_COMPATIBILITY currently holds a single value, so
  // oldest === newest and only the too_old / too_new branches below can fire (the
  // final `unsupported` branch is unreachable today). These are forward-looking:
  // once the UI supports a range with gaps, an in-range-but-unsupported value can
  // occur and the `unsupported` branch covers it.
  const oldestSupported = PROPR_UI_SUPPORTED_API_COMPATIBILITY[0];
  const newestSupported = PROPR_UI_SUPPORTED_API_COMPATIBILITY[PROPR_UI_SUPPORTED_API_COMPATIBILITY.length - 1];
  if (apiCompatibility < oldestSupported) {
    return {
      compatible: false,
      apiCompatibility,
      apiVersion,
      reason: 'too_old',
      message: `This ProPR instance is too old for the hosted UI. Update the local ProPR stack to API compatibility ${oldestSupported} or newer.`,
    };
  }
  if (apiCompatibility > newestSupported) {
    return {
      compatible: false,
      apiCompatibility,
      apiVersion,
      reason: 'too_new',
      message: `This ProPR instance is newer than the hosted UI supports. Update the hosted UI or use the matching local UI for API compatibility ${apiCompatibility}.`,
    };
  }

  return {
    compatible: false,
    apiCompatibility,
    apiVersion,
    reason: 'unsupported',
    message: `This hosted UI supports API compatibility ${PROPR_UI_SUPPORTED_API_COMPATIBILITY.join(', ')}, but the local ProPR instance reports ${apiCompatibility}.`,
  };
}
