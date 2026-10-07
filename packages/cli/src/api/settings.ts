import { isUnattendedMaxConcurrent, isUsageTipsCooldownDays, MAX_PROVIDER_REPLACEMENTS_LIMIT, parseMaxProviderReplacements, parseUnattendedWindow, UNATTENDED_MAX_CONCURRENT_MAX, UNATTENDED_MAX_CONCURRENT_MIN } from '@propr/shared';
/**
 * System Settings API
 *
 * Functions for interacting with the ProPR backend system settings endpoints.
 * These functions provide a typed interface to view and update global system configuration
 * like worker concurrency and model settings.
 */

import { ApiClient, createApiClient } from "./client.js";
import {
  REASONING_LEVELS,
  REVIEW_CONTEXT_BUDGET_PERCENT_OPTIONS,
  REVIEW_LEGACY_MAX_CONTEXT_TOKENS_MAX,
  REVIEW_LEGACY_MAX_CONTEXT_TOKENS_MIN,
  isValidLegacyReviewMaxContextTokens,
  isValidReviewContextBudgetPercent,
  normalizeModelReasoningLevel,
} from "@propr/shared";

/**
 * Maximum allowed length for the free-form `pr_review_prompt` setting.
 * Mirrors the server-side limit enforced in the config routes.
 */
const MAX_PR_REVIEW_PROMPT_LENGTH = 20000;

/**
 * System settings configuration object.
 * These settings control global system behavior.
 */
export interface SystemSettings {
  usage_tips_enabled: boolean;
  usage_tips_dismissal_cooldown_days: number;
  /**
   * Alias of the default implementation agent.
   */
  default_agent_alias?: string;

  /**
   * Number of concurrent workers for processing tasks.
   */
  worker_concurrency: number;

  /**
   * Replacement attempts dispatched after transient provider failures (0 disables).
   */
  max_provider_replacements?: number;

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
   * @deprecated Retained for REST compatibility only. Post-implementation analysis
   * was removed, so this setting has no effect.
   */
  auto_followup_score_threshold: number;

  /** Deprecation reasons for legacy settings returned by the server. */
  deprecated_settings?: Record<string, string>;

  /**
   * When enabled, the system will automatically merge the PR base branch into
   * contributor branches and ask an agent to resolve any conflicts.
   */
  auto_resolve_merge_conflicts: boolean;
  dashboard_summary_enabled: boolean;

  /**
   * Global reasoning effort/level for supported GPT and Claude agents.
   * Empty string means use the selected agent CLI's built-in default.
   */
  model_reasoning_level: string;

  /**
   * Model identifier used for full PR reviews.
   * Empty string means use the default agent model.
   */
  pr_review_model: string;

  /**
   * Operator-configured review prompt that overrides the default high-level
   * review guidance. Empty string means use the built-in review prompt.
   */
  pr_review_prompt: string;

  /** Whether PR reviews gather related unchanged repository context. */
  pr_review_context_enabled: boolean;

  /** Model used by the read-only PR review context scout. */
  pr_review_context_model: string;

  /**
   * Legacy absolute PR review input token cap; 0 means no cap. When positive,
   * the lower of this cap and the percentage budget applies.
   */
  pr_review_max_context_tokens: number;

  /** Review context budget: percentage (10-100, steps of 10) of each reviewer's safe input capacity. */
  pr_review_context_budget_percent: number;

  /**
   * Target quality rating (1-10) that ultrafix cycles aim to reach.
   */
  ultrafix_escalation_enabled: boolean;
  ultrafix_escalation_models: string[];
  ultrafix_escalation_patience: number;
  ultrafix_escalation_max_reasoning_levels: number;
  ultrafix_rating_goal: number;

  /**
   * Maximum number of ultrafix improvement cycles before stopping.
   */
  ultrafix_max_cycles: number;

  /**
   * Pause duration in seconds between ultrafix cycles.
   */
  ultrafix_pause_seconds: number;

  /**
   * Instance default per-run spend cap in USD (0 = no cap).
   */
  default_max_cost_usd?: number;

  /** Pause unattended agent runs at this percent of Agent Tank subscription usage (50-100). */
  agent_run_usage_pause_percent?: number;

  /** Most unattended agent runs (schedule, API, MCP, CLI) active at once. */
  unattended_max_concurrent?: number;

  /** Local-time window for unattended agent runs (HH:MM-HH:MM@Time/Zone); null = no window. */
  unattended_window?: string | null;

  /**
   * Milliseconds an Ultrafix review may wait for blocking CI before the loop stops.
   */
  ultrafix_ci_wait_timeout_ms: number;

  /** Agent network policy overrides; null uses the environment default. */
  agent_network_mode?: "open" | "restricted" | null;
  agent_network_mode_enforced?: boolean | null;
  agent_network_allow?: string[] | null;
  agent_network_ignore_repository_allow?: boolean | null;
  agent_network_defaults?: Record<string, unknown>;
  agent_network_effective?: Record<string, unknown>;

  /**
   * Agent watchdog overrides (null = the environment default applies; 0 disables the rule).
   * Absent when the server predates the watchdog.
   */
  agent_stall_timeout_ms?: number | null;
  agent_tool_stall_timeout_ms?: number | null;
  agent_degenerate_output_limit?: number | null;
  /** Environment defaults used when an override is null. */
  agent_watchdog_defaults?: Record<string, number>;
  /** Thresholds in force for the next agent run. */
  agent_watchdog_effective?: Record<string, number>;

  /** Why the stored unattended window is unusable; unattended agent runs are blocked until it is fixed. */
  unattended_window_error?: string;
}

export const NAMED_CONFIG_ENDPOINTS = {
  prLabel: "/api/config/pr-label",
  aiPrimaryTag: "/api/config/ai-primary-tag",
  primaryProcessingLabels: "/api/config/primary-processing-labels",
  followupKeywords: "/api/config/followup-keywords",
} as const;

export type NamedConfigEndpoint =
  typeof NAMED_CONFIG_ENDPOINTS[keyof typeof NAMED_CONFIG_ENDPOINTS];

export interface NamedConfigValueByEndpoint {
  "/api/config/pr-label": { pr_label: string };
  "/api/config/ai-primary-tag": { ai_primary_tag: string };
  "/api/config/primary-processing-labels": { primary_processing_labels: string[] };
  "/api/config/followup-keywords": { followup_keywords: string[] };
}

export interface ReindexAllResponse {
  success: boolean;
  repositoriesQueued: number;
  repositoriesSkippedCooldown: number;
  repositoriesSkippedAlreadyQueued: number;
  repositoriesFailedClone: number;
  ignoreCooldown: boolean;
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
  usage_tips_enabled?: boolean;
  usage_tips_dismissal_cooldown_days?: number;
  /**
   * Alias of the default implementation agent.
   */
  default_agent_alias?: string;

  /**
   * Number of concurrent workers for processing tasks.
   */
  worker_concurrency?: number;

  /**
   * Replacement attempts dispatched after transient provider failures (0 disables).
   */
  max_provider_replacements?: number;

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
   * @deprecated Legacy REST update option accepted for compatibility only.
   * Post-implementation analysis was removed, so writing this has no effect.
   */
  auto_followup_score_threshold?: number;

  /**
   * When enabled, the system will automatically merge the PR base branch into
   * contributor branches and ask an agent to resolve any conflicts.
   */
  auto_resolve_merge_conflicts?: boolean;
  dashboard_summary_enabled?: boolean;

  /**
   * Global reasoning effort/level for supported GPT and Claude agents.
   * Empty string means use the selected agent CLI's built-in default.
   */
  model_reasoning_level?: string;

  /**
   * Model identifier used for full PR reviews.
   * Empty string means use the default agent model.
   */
  pr_review_model?: string;

  /**
   * Operator-configured review prompt that overrides the default high-level
   * review guidance. Empty string means use the built-in review prompt.
   */
  pr_review_prompt?: string;

  /** Whether PR reviews gather related unchanged repository context. */
  pr_review_context_enabled?: boolean;

  /** Model used by the read-only PR review context scout. */
  pr_review_context_model?: string;

  /** Legacy absolute PR review input token cap; 0 removes it. */
  pr_review_max_context_tokens?: number;

  /** Review context budget percentage (10-100, steps of 10). */
  pr_review_context_budget_percent?: number;

  /**
   * Target quality rating (1-10) that ultrafix cycles aim to reach.
   */
  ultrafix_escalation_enabled?: boolean;
  ultrafix_escalation_models?: string[];
  ultrafix_escalation_patience?: number;
  ultrafix_escalation_max_reasoning_levels?: number;
  ultrafix_rating_goal?: number;

  /**
   * Maximum number of ultrafix improvement cycles before stopping.
   */
  ultrafix_max_cycles?: number;

  /**
   * Pause duration in seconds between ultrafix cycles.
   */
  ultrafix_pause_seconds?: number;

  /**
   * Instance default per-run spend cap in USD (0 = no cap).
   */
  default_max_cost_usd?: number;

  /** Pause unattended agent runs at this percent of Agent Tank subscription usage (50-100). */
  agent_run_usage_pause_percent?: number;

  /** Most unattended agent runs (schedule, API, MCP, CLI) active at once. */
  unattended_max_concurrent?: number;

  /** Local-time window for unattended agent runs (HH:MM-HH:MM@Time/Zone); null = no window. */
  unattended_window?: string | null;

  /**
   * Milliseconds an Ultrafix review may wait for blocking CI before the loop stops.
   */
  ultrafix_ci_wait_timeout_ms?: number;

  /** Agent watchdog overrides; null restores the environment default. */
  agent_stall_timeout_ms?: number | null;
  agent_tool_stall_timeout_ms?: number | null;
  agent_degenerate_output_limit?: number | null;

  /** Agent network policy overrides; null restores the environment default. */
  agent_network_mode?: "open" | "restricted" | null;
  agent_network_mode_enforced?: boolean | null;
  agent_network_allow?: string[] | null;
  agent_network_ignore_repository_allow?: boolean | null;
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

  /**
   * Non-blocking compatibility warnings detected after the settings were saved.
   */
  warnings?: string[];
}

/**
 * Valid setting keys that can be updated.
 */
export type SettingKey = Exclude<keyof SystemSettings, 'auto_followup_score_threshold' | 'deprecated_settings' | 'agent_watchdog_defaults' | 'agent_watchdog_effective' | 'agent_network_defaults' | 'agent_network_effective' | 'unattended_window_error'>;

/**
 * List of valid setting keys for validation.
 */
export const VALID_SETTING_KEYS: SettingKey[] = [
  "usage_tips_enabled",
  "usage_tips_dismissal_cooldown_days",
  "default_agent_alias",
  "worker_concurrency",
  "max_provider_replacements",
  "github_user_whitelist",
  "analysis_model_fast",
  "planner_context_model",
  "planner_generation_model",
  "auto_resolve_merge_conflicts",
  "dashboard_summary_enabled",
  "model_reasoning_level",
  "pr_review_model",
  "pr_review_prompt",
  "pr_review_context_enabled",
  "pr_review_context_model",
  "pr_review_max_context_tokens",
  "pr_review_context_budget_percent",
  "ultrafix_escalation_enabled",
  "ultrafix_escalation_models",
  "ultrafix_escalation_patience",
  "ultrafix_escalation_max_reasoning_levels",
  "ultrafix_rating_goal",
  "ultrafix_max_cycles",
  "ultrafix_pause_seconds",
  "default_max_cost_usd",
  "agent_run_usage_pause_percent",
  "unattended_max_concurrent",
  "unattended_window",
  "ultrafix_ci_wait_timeout_ms",
  "agent_stall_timeout_ms",
  "agent_tool_stall_timeout_ms",
  "agent_degenerate_output_limit",
  "agent_network_mode",
  "agent_network_mode_enforced",
  "agent_network_allow",
  "agent_network_ignore_repository_allow",
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
export function parseSettingValue(key: SettingKey, value: string): number | string | string[] | boolean | null {
  switch (key) {
    case "agent_stall_timeout_ms":
    case "agent_tool_stall_timeout_ms":
    case "agent_degenerate_output_limit": {
      // "default" (or "null") clears the override so the environment default applies.
      if (/^(default|null)$/i.test(value.trim())) return null;
      if (!/^\d+$/.test(value)) {
        throw new Error(`Invalid value for ${key}: must be a non-negative integer (0 disables), or "default"`);
      }
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed)) {
        throw new Error(`Invalid value for ${key}: must be a non-negative integer up to ${Number.MAX_SAFE_INTEGER}`);
      }
      return parsed;
    }
    case "agent_network_mode": {
      if (/^(default|null)$/i.test(value.trim())) return null;
      const mode = value.trim().toLowerCase();
      if (mode !== "open" && mode !== "restricted") {
        throw new Error(`Invalid value for ${key}: must be "open", "restricted" or "default"`);
      }
      return mode;
    }
    case "agent_network_mode_enforced":
    case "agent_network_ignore_repository_allow": {
      if (/^(default|null)$/i.test(value.trim())) return null;
      const lower = value.trim().toLowerCase();
      if (lower !== "true" && lower !== "false") {
        throw new Error(`Invalid value for ${key}: must be "true", "false" or "default"`);
      }
      return lower === "true";
    }
    case "agent_network_allow":
      // Comma-separated hostnames; "default" restores the environment list.
      if (/^(default|null)$/i.test(value.trim())) return null;
      return value.split(",").map((s) => s.trim().toLowerCase()).filter((s) => s.length > 0);
    case "usage_tips_dismissal_cooldown_days": {
      const parsed = /^\d+$/.test(value) ? Number(value) : NaN;
      if (!isUsageTipsCooldownDays(parsed)) throw new Error('Cooldown must be an integer from 1 to 365');
      return parsed;
    }
    case "worker_concurrency": {
      if (!/^-?\d+$/.test(value)) {
        throw new Error(`Invalid value for ${key}: must be an integer`);
      }
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed)) {
        throw new Error(`Invalid value for ${key}: must be an integer up to ${Number.MAX_SAFE_INTEGER}`);
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
    case "ultrafix_escalation_patience":
    case "ultrafix_ci_wait_timeout_ms":
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
    case "ultrafix_escalation_max_reasoning_levels":
    case "max_provider_replacements": {
      const parsed = parseMaxProviderReplacements(value);
      if (parsed === null) {
        throw new Error(`Invalid value for ${key}: must be an integer from 0 to ${MAX_PROVIDER_REPLACEMENTS_LIMIT}`);
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
    case "default_max_cost_usd": {
      const trimmed = value.trim().replace(/^\$/, "");
      const parsed = /^\d+(?:\.\d+)?$/.test(trimmed) ? Number(trimmed) : Number.NaN;
      if (!Number.isFinite(parsed) || parsed > 100000) {
        throw new Error(`Invalid value for ${key}: must be a USD amount from 0 (no cap) to 100000`);
      }
      return parsed;
    }
    case "agent_run_usage_pause_percent": {
      const parsed = /^\d+%?$/.test(value.trim()) ? Number(value.trim().replace(/%$/, "")) : Number.NaN;
      if (!Number.isInteger(parsed) || parsed < 50 || parsed > 100) {
        throw new Error(`Invalid value for ${key}: must be an integer from 50 to 100`);
      }
      return parsed;
    }
    case "unattended_max_concurrent": {
      const parsed = /^\d+$/.test(value.trim()) ? Number(value.trim()) : Number.NaN;
      if (!isUnattendedMaxConcurrent(parsed)) {
        throw new Error(`Invalid value for ${key}: must be an integer from ${UNATTENDED_MAX_CONCURRENT_MIN} to ${UNATTENDED_MAX_CONCURRENT_MAX}`);
      }
      return parsed;
    }
    case "unattended_window": {
      // "none" (or an empty value) removes the window.
      const trimmed = value.trim();
      if (trimmed === "" || /^(none|null|off)$/i.test(trimmed)) return null;
      const parsed = parseUnattendedWindow(trimmed);
      if (!parsed.ok) throw new Error(`Invalid value for ${key}: ${parsed.error}`);
      return trimmed;
    }
    case "pr_review_max_context_tokens": {
      const parsed = /^\d+$/.test(value) ? Number(value) : Number.NaN;
      if (!isValidLegacyReviewMaxContextTokens(parsed)) {
        throw new Error(`Invalid value for ${key}: must be 0 (no legacy cap) or an integer between ${REVIEW_LEGACY_MAX_CONTEXT_TOKENS_MIN} and ${REVIEW_LEGACY_MAX_CONTEXT_TOKENS_MAX}`);
      }
      return parsed;
    }
    case "pr_review_context_budget_percent": {
      const parsed = /^\d+%?$/.test(value) ? Number(value.replace(/%$/, "")) : Number.NaN;
      if (!isValidReviewContextBudgetPercent(parsed)) {
        throw new Error(`Invalid value for ${key}: must be one of ${REVIEW_CONTEXT_BUDGET_PERCENT_OPTIONS.join(", ")}`);
      }
      return parsed;
    }
    case "ultrafix_escalation_models": {
      const parsed: unknown = JSON.parse(value);
      if (!Array.isArray(parsed) || parsed.some(m => typeof m !== 'string' || !m.trim())) {
        throw new Error('Escalation models must be a JSON array of nonempty model names');
      }
      return parsed.map(m => m.trim());
    }
    case "ultrafix_escalation_enabled":
    case "usage_tips_enabled":
    case "dashboard_summary_enabled":
    case "auto_resolve_merge_conflicts":
    case "pr_review_context_enabled": {
      const lower = value.toLowerCase();
      if (lower !== "true" && lower !== "false") {
        throw new Error(`Invalid value for ${key}: must be "true" or "false"`);
      }
      return lower === "true";
    }
    case "model_reasoning_level": {
      const normalized = normalizeModelReasoningLevel(value);
      if (normalized === null) {
        if (value.trim() === "") {
          throw new Error(`Invalid value for ${key}: must not be whitespace-only; use an empty string to clear`);
        }
        throw new Error(`Invalid value for ${key}: must be one of: ${REASONING_LEVELS.join(", ")}, or an empty string`);
      }
      return normalized;
    }
    case "github_user_whitelist":
      // Parse comma-separated list
      return value.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
    case "analysis_model_fast":
    case "default_agent_alias":
    case "planner_context_model":
    case "planner_generation_model":
      return value;
    case "pr_review_model":
    case "pr_review_context_model": {
      const trimmed = value.trim();
      if (trimmed === '' && value.length > 0) {
        throw new Error(`Invalid value for ${key}: must not be whitespace-only; use an empty string to clear`);
      }
      return trimmed;
    }
    case "pr_review_prompt": {
      if (value.length > MAX_PR_REVIEW_PROMPT_LENGTH) {
        throw new Error(`Invalid value for ${key}: must be at most ${MAX_PR_REVIEW_PROMPT_LENGTH} characters`);
      }
      return value;
    }
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
 *   auto_resolve_merge_conflicts: true
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
 * // Update merge-conflict resolution
 * await updateSetting("auto_resolve_merge_conflicts", true);
 * ```
 */
export async function updateSetting(
  key: SettingKey,
  value: number | string | string[] | boolean | null,
  client?: ApiClient
): Promise<UpdateSettingsResponse> {
  const settings: UpdateSettingsOptions = { [key]: value };
  return updateSettings(settings, client);
}

export async function getConfigValue<
  E extends NamedConfigEndpoint,
  T = NamedConfigValueByEndpoint[E],
>(
  endpoint: E,
  client?: ApiClient
): Promise<T> {
  const apiClient = client ?? (await createApiClient());
  const response = await apiClient.get<T>(endpoint);
  return response.data;
}

export async function updateConfigValue<
  E extends NamedConfigEndpoint,
  T = { success?: boolean },
>(
  endpoint: E,
  body: Partial<NamedConfigValueByEndpoint[E]>,
  client?: ApiClient
): Promise<T> {
  const apiClient = client ?? (await createApiClient());
  const response = await apiClient.post<T>(endpoint, { body });
  return response.data;
}

export async function triggerSummarizationReindexAll(
  ignoreCooldown: boolean = false,
  client?: ApiClient
): Promise<ReindexAllResponse> {
  const apiClient = client ?? (await createApiClient());
  const response = await apiClient.post<ReindexAllResponse>(
    "/api/config/summarization/reindex-all",
    { body: { ignoreCooldown } }
  );
  return response.data;
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
 * await settingsApi.updateSetting("auto_resolve_merge_conflicts", true);
 * ```
 */
export const settingsApi = {
  getSettings,
  updateSettings,
  updateSetting,
  getConfigValue,
  updateConfigValue,
  triggerSummarizationReindexAll,
  isValidSettingKey,
  parseSettingValue,
  VALID_SETTING_KEYS,
} as const;
