// Re-export from the single source of truth in @propr/shared.
// Local names preserved for backwards compatibility with existing call sites.
import { getGithubUserWhitelist, isGithubUserWhitelisted } from '@propr/shared';

export const getUserWhitelist = getGithubUserWhitelist;
export const isUserWhitelisted = isGithubUserWhitelisted;
