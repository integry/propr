/**
 * System Settings Commands
 *
 * CLI commands for managing system settings using the ProPR backend.
 * Provides the `setting` command group with `get` and `update` subcommands.
 */

import { Command } from "commander";
import {
  getSettings,
  updateSetting,
  getConfigValue,
  updateConfigValue,
  triggerSummarizationReindexAll,
  isValidSettingKey,
  parseSettingValue,
  VALID_SETTING_KEYS,
  SystemSettings,
  SettingKey,
  NamedConfigEndpoint,
} from "../api/index.js";
import {
  printOutput,
} from "../utils/index.js";

/**
 * Formats a setting value for display.
 */
function formatValue(value: unknown): string {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return "(empty)";
    }
    return value.join(", ");
  }
  if (value === null || value === undefined || value === "") {
    return "(not set)";
  }
  return String(value);
}

/**
 * Gets a human-readable description for a setting key.
 */
function getSettingDescription(key: SettingKey): string {
  const descriptions: Record<SettingKey, string> = {
    default_agent_alias: "Alias of the default implementation agent",
    worker_concurrency: "Number of concurrent workers for processing tasks",
    github_user_whitelist: "GitHub usernames allowed to use the system",
    analysis_model_fast: "Model for fast analysis operations",
    planner_context_model: "Model for planner context generation",
    planner_generation_model: "Model for planner generation",
    auto_followup_score_threshold: "Score threshold (0-9) for auto-followup",
    auto_resolve_merge_conflicts: "Automatically resolve merge conflicts",
    pr_review_model: "Model for full PR reviews",
    pr_review_prompt: "Override for the PR review prompt guidance (empty = built-in default)",
    ultrafix_rating_goal: "Target quality rating for ultrafix cycles",
    ultrafix_max_cycles: "Maximum number of ultrafix cycles",
    ultrafix_pause_seconds: "Pause duration between ultrafix cycles",
  };
  return descriptions[key];
}

function formatSettingKeysHelp(): string {
  return VALID_SETTING_KEYS
    .map((key) => `  ${key.padEnd(32)} ${getSettingDescription(key)}`)
    .join("\n");
}

function printValidSettingKeys(includeDescriptions = false): void {
  console.log("Valid setting keys:");
  for (const validKey of VALID_SETTING_KEYS) {
    const description = includeDescriptions ? `: ${getSettingDescription(validKey)}` : "";
    console.log(`  - ${validKey}${description}`);
  }
}

const EXTRA_CONFIG_ENDPOINTS = {
  "pr-label": {
    endpoint: "/api/config/pr-label",
    field: "pr_label",
    description: "GitHub label applied to ProPR-created PRs",
    type: "string",
  },
  "ai-primary-tag": {
    endpoint: "/api/config/ai-primary-tag",
    field: "ai_primary_tag",
    description: "Primary AI tag used for issue/PR processing",
    type: "string",
  },
  "primary-processing-labels": {
    endpoint: "/api/config/primary-processing-labels",
    field: "primary_processing_labels",
    description: "Labels that enable processing on existing PRs",
    type: "array",
  },
  "followup-keywords": {
    endpoint: "/api/config/followup-keywords",
    field: "followup_keywords",
    description: "Keywords that trigger PR follow-up processing",
    type: "array",
  },
} as const;

type ExtraConfigKey = keyof typeof EXTRA_CONFIG_ENDPOINTS;
type ExtraConfigGetter = (endpoint: NamedConfigEndpoint) => Promise<Record<string, unknown>>;
type DisplaySettings = Record<string, unknown>;

const EXTRA_CONFIG_ERROR_KEY = "__extraConfigErrors";

function isExtraConfigKey(key: string): key is ExtraConfigKey {
  return key in EXTRA_CONFIG_ENDPOINTS;
}

export function parseExtraConfigValue(key: ExtraConfigKey, value: string): string | string[] {
  const config = EXTRA_CONFIG_ENDPOINTS[key];
  if (config.type === "array") {
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`Setting "${key}" requires a non-empty value.`);
  }
  return trimmed;
}

export function getExtraConfigErrors(settings: DisplaySettings): string[] {
  const errors = settings[EXTRA_CONFIG_ERROR_KEY];
  return Array.isArray(errors) ? errors.filter((item): item is string => typeof item === "string") : [];
}

export function isSuccessfulExtraConfigUpdate(result: unknown): boolean {
  return Boolean(
    result &&
    typeof result === "object" &&
    !Array.isArray(result) &&
    (result as { success?: unknown }).success === true
  );
}

export async function getExtraConfigSetting(
  key: ExtraConfigKey,
  getter: ExtraConfigGetter = getConfigValue
): Promise<unknown> {
  const config = EXTRA_CONFIG_ENDPOINTS[key];
  const result = await getter(config.endpoint);
  return result[config.field];
}

export async function getAllDisplaySettings(
  settings: SystemSettings,
  getter: ExtraConfigGetter = getConfigValue
): Promise<DisplaySettings> {
  const extras = await Promise.allSettled(
    (Object.keys(EXTRA_CONFIG_ENDPOINTS) as ExtraConfigKey[]).map(async (key) => [
      key,
      await getExtraConfigSetting(key, getter),
    ] as const)
  );
  const displaySettings: DisplaySettings = {
    ...settings,
    ...Object.fromEntries(
      extras
        .filter((result): result is PromiseFulfilledResult<readonly [ExtraConfigKey, unknown]> => result.status === "fulfilled")
        .map((result) => result.value)
    ),
  };
  const errors = extras
    .map((result, index) => ({ result, key: (Object.keys(EXTRA_CONFIG_ENDPOINTS) as ExtraConfigKey[])[index] }))
    .filter((item): item is { result: PromiseRejectedResult; key: ExtraConfigKey } => item.result.status === "rejected")
    .map(({ key, result }) => `${key}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
  if (errors.length > 0) {
    Object.defineProperty(displaySettings, EXTRA_CONFIG_ERROR_KEY, {
      value: errors,
      enumerable: false,
    });
  }
  return displaySettings;
}

function printAllValidKeys(includeDescriptions = false): void {
  printValidSettingKeys(includeDescriptions);
  console.log("Additional config keys:");
  for (const [key, config] of Object.entries(EXTRA_CONFIG_ENDPOINTS)) {
    console.log(`  - ${key}${includeDescriptions ? `: ${config.description}` : ""}`);
  }
}

/**
 * Displays all settings in a formatted table.
 */
function displaySettingsTable(settings: DisplaySettings): void {
  const keys = Object.keys(settings);
  const keyWidth = Math.max("Setting".length, ...keys.map((k) => k.length));
  const valueWidth = Math.max(
    "Value".length,
    ...keys.map((k) => formatValue(settings[k]).length)
  );

  const header = [
    "Setting".padEnd(keyWidth),
    "Value".padEnd(valueWidth),
  ].join("  ");

  console.log(header);
  console.log("-".repeat(header.length));

  for (const key of keys) {
    const value = settings[key];
    const row = [
      key.padEnd(keyWidth),
      formatValue(value).padEnd(valueWidth),
    ].join("  ");

    console.log(row);
  }
}

/**
 * Displays detailed information about a single setting.
 */
function displaySettingDetail(key: string, value: unknown, description: string): void {
  console.log("");
  console.log("=".repeat(50));
  console.log(`Setting: ${key}`);
  console.log("=".repeat(50));
  console.log("");
  console.log(`Description: ${description}`);
  console.log(`Value:       ${formatValue(value)}`);
  console.log("");
}

/**
 * Creates the `setting` command group.
 */
export function createSettingCommand(): Command {
  const setting = new Command("setting")
    .description("Manage system settings")
    .addHelpText("after", `
Examples:
  $ propr setting get                                    # Show all settings
  $ propr setting get -k worker_concurrency              # Show specific setting
  $ propr setting get -k followup-keywords               # Show label/keyword setting
  $ propr setting update worker_concurrency 10           # Update a setting
  $ propr setting reindex-summaries                      # Reindex all summaries
`);

  // setting get
  setting
    .command("get")
    .description("View current system settings for ProPR backend")
    .option("-k, --key <key>", "Show only a specific setting key")
    .option("-j, --json", "Output settings as JSON")
    .addHelpText("after", `
Valid Setting Keys:
${formatSettingKeysHelp()}
  pr-label                         GitHub label applied to ProPR-created PRs
  ai-primary-tag                   Primary AI tag used for issue/PR processing
  primary-processing-labels        Labels that enable processing on existing PRs
  followup-keywords                Keywords that trigger PR follow-up processing

Examples:
  $ propr setting get                                 # Show all settings
  $ propr setting get -k worker_concurrency           # Show specific setting
  $ propr setting get --json                          # Output as JSON
`)
    .action(
      async (options: { key?: string; json?: boolean }) => {
        try {
          if (options.key && isExtraConfigKey(options.key)) {
            const value = await getExtraConfigSetting(options.key);
            if (options.json) {
              printOutput({ [options.key]: value }, true);
            } else {
              displaySettingDetail(options.key, value, EXTRA_CONFIG_ENDPOINTS[options.key].description);
            }
            return;
          }

          if (options.key) {
            if (!isValidSettingKey(options.key)) {
              console.error(`Error: Invalid setting key: ${options.key}`);
              console.log("");
              printAllValidKeys();
              process.exit(1);
            }
            const settings = await getSettings();
            if (options.json) {
              printOutput({ [options.key]: settings[options.key] }, true);
            } else {
              displaySettingDetail(options.key, settings[options.key], getSettingDescription(options.key));
            }
            return;
          }

          const settings = await getSettings();
          const displaySettings = await getAllDisplaySettings(settings);
          const warnings = getExtraConfigErrors(displaySettings);

          if (options.json) {
            printOutput(
              warnings.length > 0
                ? { ...displaySettings, extraConfigErrors: warnings }
                : displaySettings,
              true
            );
            return;
          }

          console.log("");
          displaySettingsTable(displaySettings);
          for (const warning of warnings) {
            console.warn(`Warning: Could not fetch extra config setting ${warning}`);
          }
          console.log("");
          console.log(`Total: ${Object.keys(displaySettings).length} setting(s)`);
        } catch (error) {
          const errorMessage = (error as Error).message;
          if (
            errorMessage.includes("401") ||
            errorMessage.includes("unauthorized")
          ) {
            console.error(
              "Error: Unauthorized. Please run 'propr login' first."
            );
          } else if (
            errorMessage.includes("403") ||
            errorMessage.includes("forbidden")
          ) {
            console.error(
              "Error: Access denied. You do not have permission to view settings."
            );
          } else {
            console.error(`Error fetching settings: ${errorMessage}`);
          }
          process.exit(1);
        }
      }
    );

  // setting update
  setting
    .command("update <key> <value>")
    .description("Update a system setting")
    .addHelpText(
      "after",
      `
Valid setting keys:
${formatSettingKeysHelp()}
  pr-label                         GitHub label applied to ProPR-created PRs
  ai-primary-tag                   Primary AI tag used for issue/PR processing
  primary-processing-labels        Labels that enable processing on existing PRs
  followup-keywords                Keywords that trigger PR follow-up processing

Examples:
  $ propr setting update worker_concurrency 10
  $ propr setting update auto_followup_score_threshold 7
  $ propr setting update github_user_whitelist "user1,user2,user3"
  $ propr setting update followup-keywords "!propr,propr"
  $ propr setting update analysis_model_fast claude-3-5-sonnet-20241022
`
    )
    .action(async (key: string, value: string) => {
      try {
        if (!isValidSettingKey(key) && !isExtraConfigKey(key)) {
          console.error(`Error: Invalid setting key: ${key}`);
          console.log("");
          printAllValidKeys(true);
          process.exit(1);
        }

        let parsedValue: number | string | string[] | boolean;
        try {
          parsedValue = isExtraConfigKey(key) ? parseExtraConfigValue(key, value) : parseSettingValue(key, value);
        } catch (parseError) {
          console.error(`Error: ${(parseError as Error).message}`);
          process.exit(1);
        }

        console.log(`Updating setting: ${key}...`);

        const result = isExtraConfigKey(key)
          ? await updateConfigValue(
              EXTRA_CONFIG_ENDPOINTS[key].endpoint,
              { [EXTRA_CONFIG_ENDPOINTS[key].field]: parsedValue }
            )
          : await updateSetting(key, parsedValue);

        const updateSucceeded = isExtraConfigKey(key)
          ? isSuccessfulExtraConfigUpdate(result)
          : result.success !== false;

        if (updateSucceeded) {
          console.log("");
          console.log(`Successfully updated setting: ${key}`);
          console.log(`  New value: ${formatValue(parsedValue)}`);
        } else {
          console.error("Failed to update setting.");
          process.exit(1);
        }
      } catch (error) {
        const errorMessage = (error as Error).message;
        if (errorMessage.includes("400")) {
          console.error(`Error: Invalid value for setting "${key}".`);
          if (isValidSettingKey(key)) {
            console.log("");
            console.log(`Description: ${getSettingDescription(key)}`);
          }
        } else if (
          errorMessage.includes("401") ||
          errorMessage.includes("unauthorized")
        ) {
          console.error("Error: Unauthorized. Please run 'propr login' first.");
        } else if (
          errorMessage.includes("403") ||
          errorMessage.includes("forbidden")
        ) {
          console.error(
            "Error: Access denied. You do not have permission to update settings."
          );
        } else if (errorMessage.includes("409")) {
          console.error(
            "Error: Configuration is being updated. Please try again."
          );
        } else {
          console.error(`Error updating setting: ${errorMessage}`);
        }
        process.exit(1);
      }
    });

  setting
    .command("reindex-summaries")
    .description("Trigger summarization reindexing for all configured repositories")
    .option("--ignore-cooldown", "Queue work even when repositories are in summarization cooldown")
    .option("-j, --json", "Output response as JSON")
    .action(async (options: { ignoreCooldown?: boolean; json?: boolean }) => {
      try {
        const result = await triggerSummarizationReindexAll(options.ignoreCooldown ?? false);
        if (printOutput(result, options.json ?? false)) {
          return;
        }
        console.log(`Queued repositories: ${result.repositoriesQueued}`);
        console.log(`Skipped by cooldown: ${result.repositoriesSkippedCooldown}`);
        console.log(`Already queued: ${result.repositoriesSkippedAlreadyQueued}`);
        console.log(`Failed clone: ${result.repositoriesFailedClone}`);
      } catch (error) {
        console.error(`Error triggering summarization reindex: ${(error as Error).message}`);
        process.exit(1);
      }
    });

  return setting;
}
