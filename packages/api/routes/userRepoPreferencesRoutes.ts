import { Request, Response } from 'express';
import { db, logger } from '@propr/core';

/**
 * User-specific repository preferences.
 * Stored in system_configs table with key `user_repo_prefs_${userId}`.
 * Maps repository names to their starred/hidden state.
 */
export interface UserRepoPreferences {
  [repositoryName: string]: {
    starred?: boolean;
    hidden?: boolean;
  };
}

/**
 * Get user repo preferences from database.
 */
async function getUserRepoPrefs(userId: string): Promise<UserRepoPreferences> {
  try {
    const key = `user_repo_prefs_${userId}`;
    const result = await db('system_configs').where({ key }).first();
    if (result && result.value !== undefined && result.value !== null) {
      return typeof result.value === 'string' ? JSON.parse(result.value) : result.value;
    }
    return {};
  } catch (error) {
    const err = error as Error;
    logger.error({ error: err.message, userId }, 'Failed to load user repo preferences');
    return {};
  }
}

/**
 * Save user repo preferences to database.
 */
async function saveUserRepoPrefs(userId: string, prefs: UserRepoPreferences): Promise<boolean> {
  try {
    const key = `user_repo_prefs_${userId}`;
    const jsonValue = JSON.stringify(prefs);
    await db('system_configs')
      .insert({
        key,
        value: jsonValue,
        updated_at: db.fn.now(),
        created_at: db.fn.now()
      })
      .onConflict('key')
      .merge({
        value: jsonValue,
        updated_at: db.fn.now()
      });
    return true;
  } catch (error) {
    const err = error as Error;
    logger.error({ error: err.message, userId }, 'Failed to save user repo preferences');
    throw error;
  }
}

export function createUserRepoPreferencesRoutes() {
  /**
   * GET /api/user/repo-preferences
   * Get user-specific repository preferences (starred, hidden states).
   */
  async function getRepoPreferences(req: Request, res: Response): Promise<void> {
    try {
      if (!req.user?.id) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const preferences = await getUserRepoPrefs(req.user.id);
      res.json({ preferences });
    } catch (error) {
      console.error('Error getting user repo preferences:', error);
      res.status(500).json({ error: error instanceof Error ? error.message : 'Internal server error' });
    }
  }

  /**
   * POST /api/user/repo-preferences
   * Update user-specific repository preferences.
   * Body: { preferences: { "owner/repo": { starred?: boolean, hidden?: boolean } } }
   *
   * This endpoint supports partial updates - only provided keys are modified.
   */
  async function updateRepoPreferences(req: Request, res: Response): Promise<void> {
    try {
      if (!req.user?.id) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const { preferences } = req.body;

      if (!preferences || typeof preferences !== 'object') {
        res.status(400).json({ error: 'preferences object is required' });
        return;
      }

      // Validate preferences structure
      for (const [repoName, prefs] of Object.entries(preferences)) {
        if (typeof repoName !== 'string' || !repoName.includes('/')) {
          res.status(400).json({ error: `Invalid repository name: ${repoName}` });
          return;
        }
        if (prefs !== null && typeof prefs !== 'object') {
          res.status(400).json({ error: `Invalid preferences for ${repoName}` });
          return;
        }
      }

      // Load existing preferences and merge with new ones
      const existingPrefs = await getUserRepoPrefs(req.user.id);
      const mergedPrefs: UserRepoPreferences = { ...existingPrefs };

      for (const [repoName, newPrefs] of Object.entries(preferences as UserRepoPreferences)) {
        if (newPrefs === null) {
          // Remove preference entry if null is passed
          delete mergedPrefs[repoName];
        } else {
          // Merge preferences for this repo
          mergedPrefs[repoName] = {
            ...mergedPrefs[repoName],
            ...newPrefs
          };

          // Clean up false values to keep storage lean
          if (mergedPrefs[repoName].starred === false) {
            delete mergedPrefs[repoName].starred;
          }
          if (mergedPrefs[repoName].hidden === false) {
            delete mergedPrefs[repoName].hidden;
          }

          // Remove empty preference objects
          if (Object.keys(mergedPrefs[repoName]).length === 0) {
            delete mergedPrefs[repoName];
          }
        }
      }

      await saveUserRepoPrefs(req.user.id, mergedPrefs);
      res.json({ success: true, preferences: mergedPrefs });
    } catch (error) {
      console.error('Error updating user repo preferences:', error);
      res.status(500).json({ error: error instanceof Error ? error.message : 'Internal server error' });
    }
  }

  return {
    getRepoPreferences,
    updateRepoPreferences
  };
}
