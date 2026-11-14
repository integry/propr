/**
 * Rescue ref naming with no imports, so webhook code can recognise rescue refs
 * without loading the git and GitHub auth modules behind `rescueRefs.ts`.
 */

/** Namespace for commits salvaged from a rejected push. Never under refs/heads, so
 * GitHub does not list them as branches and no branch-driven automation sees them. */
export const RESCUE_REF_PREFIX = 'refs/propr/rescue/';

/** True for a rescue ref in any spelling a webhook or branch listing can produce. */
export function isRescueRef(ref: string | null | undefined): boolean {
    if (!ref) return false;
    const normalized = ref.trim().replace(/^refs\/heads\//, '');
    return normalized.startsWith(RESCUE_REF_PREFIX) || normalized.startsWith('propr/rescue/');
}
