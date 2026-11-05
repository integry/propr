import { getSettings, updateSettings } from './configApi';

/**
 * Helpers for the GitHub trigger whitelist (`github_user_whitelist`), the same
 * setting edited in Settings and by the `update_trigger_access_configuration`
 * MCP tool. Each write re-reads the current list and sends its revision so a
 * concurrent edit fails with STALE_REVISION instead of being overwritten.
 */

/** Mirrors the server's effective-whitelist normalization used for revisions. */
function normalizeWhitelist(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string').map(entry => entry.trim()).filter(Boolean);
}

/**
 * Without a revision the server would accept the write unguarded and could overwrite a concurrent
 * edit, so the update is refused when hashing is unavailable (e.g. HTTP on a non-loopback host).
 */
async function whitelistRevision(whitelist: string[]): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error('This browser cannot safely update the trigger whitelist here because secure hashing is unavailable. Edit the whitelist in Settings instead.');
  }
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(whitelist)));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Comment-trigger enforcement (`filterCommentByAuthor`) compares entries exactly, so a case-distinct
 * entry such as `Developer` does not let `developer` trigger ProPR. Membership here matches that.
 */
export function isLoginInWhitelist(whitelist: string[], login: string): boolean {
  return whitelist.includes(login);
}

export const getTriggerWhitelist = async (): Promise<string[]> =>
  normalizeWhitelist((await getSettings()).github_user_whitelist);

async function saveTriggerWhitelist(current: string[], next: string[]): Promise<string[]> {
  const expectedRevision = await whitelistRevision(current);
  await updateSettings({ github_user_whitelist: next }, { expectedRevision });
  return next;
}

export const addToTriggerWhitelist = async (login: string): Promise<string[]> => {
  const current = await getTriggerWhitelist();
  if (isLoginInWhitelist(current, login)) return current;
  // The list may have been cleared since the offer was made; adding an entry now would restrict access.
  if (current.length === 0) {
    throw new Error('The trigger whitelist is now empty, so every GitHub user can trigger ProPR. Adding this user would restrict access to them alone. Edit the whitelist in Settings instead.');
  }
  return saveTriggerWhitelist(current, [...current, login]);
};

export const removeFromTriggerWhitelist = async (login: string): Promise<string[]> => {
  const current = await getTriggerWhitelist();
  // Case-distinct entries are separate whitelist entries, matching the MCP tool's exact removal.
  const next = current.filter(entry => entry !== login);
  if (next.length === current.length) return current;
  if (next.length === 0) {
    throw new Error('Removing the final trigger whitelist entry would open trigger access to every GitHub user. Edit the whitelist in Settings instead.');
  }
  return saveTriggerWhitelist(current, next);
};
