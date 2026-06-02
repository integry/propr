// User Repository Preferences API
import { API_BASE_URL, apiFetch, handleApiResponse } from './proprApi';

/**
 * User-specific repository preferences.
 * Maps repository names to their starred/hidden state.
 */
export interface UserRepoPreferences {
  [repositoryName: string]: {
    starred?: boolean;
    hidden?: boolean;
  };
}

/**
 * Response from the get preferences endpoint.
 */
export interface GetUserRepoPreferencesResponse {
  preferences: UserRepoPreferences;
}

/**
 * Response from the update preferences endpoint.
 */
export interface UpdateUserRepoPreferencesResponse {
  success: boolean;
  preferences: UserRepoPreferences;
}

/**
 * Get user-specific repository preferences.
 *
 * @returns The user's repository preferences (starred, hidden states)
 */
export const getUserRepoPreferences = async (): Promise<UserRepoPreferences> => {
  const response = await apiFetch(`${API_BASE_URL}/api/user/repo-preferences`, {
    method: 'GET',
    credentials: 'include'
  });
  await handleApiResponse(response);
  const data: GetUserRepoPreferencesResponse = await response.json();
  return data.preferences || {};
};

/**
 * Update user-specific repository preferences.
 * Supports partial updates - only provided keys are modified.
 *
 * @param preferences - Object mapping repository names to preference updates
 * @returns The updated preferences
 */
export const updateUserRepoPreferences = async (
  preferences: UserRepoPreferences
): Promise<UserRepoPreferences> => {
  const response = await apiFetch(`${API_BASE_URL}/api/user/repo-preferences`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ preferences }),
    credentials: 'include'
  });
  await handleApiResponse(response);
  const data: UpdateUserRepoPreferencesResponse = await response.json();
  return data.preferences;
};

/**
 * Toggle the starred state for a repository.
 *
 * @param repositoryName - The full repository name (e.g., "owner/repo")
 * @param starred - The new starred state
 * @returns The updated preferences
 */
export const toggleRepoStarred = async (
  repositoryName: string,
  starred: boolean
): Promise<UserRepoPreferences> => {
  return updateUserRepoPreferences({
    [repositoryName]: { starred }
  });
};

/**
 * Toggle the hidden state for a repository.
 *
 * @param repositoryName - The full repository name (e.g., "owner/repo")
 * @param hidden - The new hidden state
 * @returns The updated preferences
 */
export const toggleRepoHidden = async (
  repositoryName: string,
  hidden: boolean
): Promise<UserRepoPreferences> => {
  return updateUserRepoPreferences({
    [repositoryName]: { hidden }
  });
};
