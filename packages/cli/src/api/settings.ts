/**
 * System Settings API
 *
 * Functions for interacting with the ProPR backend system settings endpoints.
 * These functions provide a typed interface to view and update global system configuration
 * like worker concurrency, auto-followup thresholds, and model settings.
 */

import { ApiClient, createApiClient } from "./index.js";

/**
 * System settings configuration object.
 * These settings control global system behavior.
 */
export interface SystemSettings {
  /**
   * Number of concurrent workers for processing tasks.
   */
  worker_concurrency: number;

  /**
   * List of GitHub usernames allowed to use the system.
   */
  github_user_whitelist: string[];

  /**
   * Model identifier for fast analysis operations.
   */
  analysis_model_fast: string;

  /**
   * Model identifier for planner context generation.
   */
  planner_context_model: string;

  /**
   * Model identifier for planner generation.
   */
  planner_generation_model: string;

  /**
   * Score threshold (0-9) for auto-followup on issues.
   */
  auto_followup_score_threshold: number;

  /**
   * When enabled, the system will automatically merge the PR base branch into
   * contributor branches and ask an agent to resolve any conflicts.
   */
  auto_resolve_merge_conflicts: boolean;

  /**
   * Model identifier used for full PR reviews.
   * Empty string means use the default agent model.
   */
  pr_review_model: string;

  /**
   * Target quality rating (1-10) that ultrafix cycles aim to reach.
   */
  ultrafix_rating_goal: number;

  /**
   * Maximum number of ultrafix improvement cycles before stopping.
   */
  ultrafix_max_cycles: number;

  /**
   * Pause duration in seconds between ultrafix cycles.
   */
  ultrafix_pause_seconds: number;
}

/**
 * Response from the get settings endpoint.
 */
export type GetSettingsResponse = SystemSettings;

/**
 * Options for updating a setting.
 * Supports partial updates - only include fields you want to change.
 */
export interface UpdateSettingsOptions {
  /**
   * Number of concurrent workers for processing tasks.
   */
  worker_concurrency?: number;

  /**
   * List of GitHub usernames allowed to use the system.
   */
  github_user_whitelist?: string[];

  /**
   * Model identifier for fast analysis operations.
   */
  analysis_model_fast?: string;

  /**
   * Model identifier for planner context generation.
   */
  planner_context_model?: string;

  /**
   * Model identifier for planner generation.
   */
  planner_generation_model?: string;

  /**
   * Score threshold (0-9) for auto-followup on issues.
   */
  auto_followup_score_threshold?: number;

  /**
   * When enabled, the system will automatically merge the PR base branch into
   * contributor branches and ask an agent to resolve any conflicts.
   */
  auto_resolve_merge_conflicts?: boolean;

  /**
   * Model identifier used for full PR reviews.
   * Empty string means use the default agent model.
   */
  pr_review_model?: string;

  /**
   * Target quality rating (1-10) that ultrafix cycles aim to reach.
   */
  ultrafix_rating_goal?: number;

  /**
   * Maximum number of ultrafix improvement cycles before stopping.
   */
  ultrafix_max_cycles?: number;

  /**
   * Pause duration in seconds between ultrafix cycles.
   */
  ultrafix_pause_seconds?: number;
}

/**
 * Response from update settings endpoint.
 */
export interface UpdateSettingsResponse {
  /**
   * Whether the operation was successful.
   */
  success: boolean;

  /**
   * The updated settings object.
   */
  settings: UpdateSettingsOptions;
}

/**
 * Valid setting keys that can be updated.
 */
export type SettingKey = keyof SystemSettings;

/**
 * List of valid setting keys for validation.
 */
export const VALID_SETTING_KEYS: SettingKey[] = [
  "worker_concurrency",
  "github_user_whitelist",
  "analysis_model_fast",
  "planner_context_model",
  "planner_generation_model",
  "auto_followup_score_threshold",
  "auto_resolve_merge_conflicts",
  "pr_review_model",
  "ultrafix_rating_goal",
  "ultrafix_max_cycles",
  "ultrafix_pause_seconds",
];

/**
 * Validates if a string is a valid setting key.
 *
 * @param key - The key to validate.
 * @returns True if the key is valid, false otherwise.
 */
export function isValidSettingKey(key: string): key is SettingKey {
  return VALID_SETTING_KEYS.includes(key as SettingKey);
}

/**
 * Parses a value string to the appropriate type for the given setting key.
 *
 * @param key - The setting key.
 * @param value - The value string to parse.
 * @returns The parsed value.
 * @throws Error if the value cannot be parsed for the given key.
 */
export function parseSettingValue(key: SettingKey, value: string): number | string | string[] | boolean {
  switch (key) {
    case "worker_concurrency":
    case "auto_followup_score_threshold": {
      if (!/^-?\d+$/.test(value)) {
        throw new Error(`Invalid value for ${key}: must be an integer`);
      }
      const parsed = Number(value);
      if (key === "auto_followup_score_threshold" && (parsed < 0 || parsed > 9)) {
        throw new Error(`Invalid value for ${key}: must be between 0 and 9`);
      }
      if (key === "worker_concurrency" && parsed < 1) {
        throw new Error(`Invalid value for ${key}: must be at least 1`);
      }
      return parsed;
    }
    case "ultrafix_rating_goal": {
      if (!/^\d+$/.test(value)) {
        throw new Error(`Invalid value for ${key}: must be a positive integer between 1 and 10`);
      }
      const parsed = Number(value);
      if (parsed < 1 || parsed > 10) {
        throw new Error(`Invalid value for ${key}: must be a number between 1 and 10`);
      }
      return parsed;
    }
    case "ultrafix_max_cycles": {
      if (!/^\d+$/.test(value)) {
        throw new Error(`Invalid value for ${key}: must be a positive integer`);
      }
      const parsed = Number(value);
      if (parsed < 1 || !Number.isSafeInteger(parsed)) {
        throw new Error(`Invalid value for ${key}: must be a positive integer up to ${Number.MAX_SAFE_INTEGER}`);
      }
      return parsed;
    }
    case "ultrafix_pause_seconds": {
      if (!/^\d+$/.test(value)) {
        throw new Error(`Invalid value for ${key}: must be a non-negative integer`);
      }
      const parsed = Number(value);
      if (parsed < 0 || !Number.isSafeInteger(parsed)) {
        throw new Error(`Invalid value for ${key}: must be a non-negative integer up to ${Number.MAX_SAFE_INTEGER}`);
      }
      return parsed;
    }
    case "auto_resolve_merge_conflicts": {
      const lower = value.toLowerCase();
      if (lower !== "true" && lower !== "false") {
        throw new Error(`Invalid value for ${key}: must be "true" or "false"`);
      }
      return lower === "true";
    }
    case "github_user_whitelist":
      // Parse comma-separated list
      return value.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
    case "analysis_model_fast":
    case "planner_context_model":
    case "planner_generation_model":
    case "pr_review_model":
      return value;
    default:
      return value;
  }
}

/**
 * Fetches the current system settings.
 *
 * @param client - Optional ApiClient instance. If not provided, one will be created.
 * @returns A promise resolving to the current system settings.
 *
 * @example
 * ```typescript
 * const settings = await getSettings();
 * console.log(`Worker concurrency: ${settings.worker_concurrency}`);
 * console.log(`Auto-followup threshold: ${settings.auto_followup_score_threshold}`);
 * ```
 */
export async function getSettings(client?: ApiClient): Promise<GetSettingsResponse> {
  const apiClient = client ?? (await createApiClient());

  const response = await apiClient.get<GetSettingsResponse>("/api/config/settings");

  return response.data;
}

/**
 * Updates one or more system settings.
 *
 * @param settings - Object containing settings to update.
 * @param client - Optional ApiClient instance. If not provided, one will be created.
 * @returns A promise resolving to the update response.
 *
 * @example
 * ```typescript
 * // Update a single setting
 * await updateSettings({ worker_concurrency: 10 });
 *
 * // Update multiple settings
 * await updateSettings({
 *   worker_concurrency: 10,
 *   auto_followup_score_threshold: 7
 * });
 * ```
 */
export async function updateSettings(
  settings: UpdateSettingsOptions,
  client?: ApiClient
): Promise<UpdateSettingsResponse> {
  const apiClient = client ?? (await createApiClient());

  const response = await apiClient.post<UpdateSettingsResponse>("/api/config/settings", {
    body: { settings },
  });

  return response.data;
}

/**
 * Updates a single system setting by key.
 *
 * @param key - The setting key to update.
 * @param value - The new value for the setting.
 * @param client - Optional ApiClient instance. If not provided, one will be created.
 * @returns A promise resolving to the update response.
 *
 * @example
 * ```typescript
 * // Update worker concurrency
 * await updateSetting("worker_concurrency", 10);
 *
 * // Update auto-followup threshold
 * await updateSetting("auto_followup_score_threshold", 7);
 * ```
 */
export async function updateSetting(
  key: SettingKey,
  value: number | string | string[] | boolean,
  client?: ApiClient
): Promise<UpdateSettingsResponse> {
  const settings: UpdateSettingsOptions = { [key]: value };
  return updateSettings(settings, client);
}

/**
 * Settings API namespace providing all system settings operations.
 *
 * @example
 * ```typescript
 * import { settingsApi } from "@propr/cli/api";
 *
 * // Get current settings
 * const settings = await settingsApi.getSettings();
 *
 * // Update settings
 * await settingsApi.updateSettings({ worker_concurrency: 10 });
 *
 * // Update a single setting
 * await settingsApi.updateSetting("auto_followup_score_threshold", 7);
 * ```
 */
export const settingsApi = {
  getSettings,
  updateSettings,
  updateSetting,
  isValidSettingKey,
  parseSettingValue,
  VALID_SETTING_KEYS,
} as const;
