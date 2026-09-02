/**
 * One epoch owns every deterministic packaged-acceptance clock. Production
 * code must consume it only through the dual-authorized acceptance boundary.
 */
export const PACKAGED_ACCEPTANCE_EPOCH_MILLISECONDS = 1_767_323_045_000;
export const PACKAGED_ACCEPTANCE_TIME = new Date(
  PACKAGED_ACCEPTANCE_EPOCH_MILLISECONDS,
).toISOString();
