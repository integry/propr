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
  isValidSettingKey,
  parseSettingValue,
  VALID_SETTING_KEYS,
  SystemSettings,
  SettingKey,
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
    ultrafix_rating_goal: "Target quality rating for ultrafix cycles",
    ultrafix_max_cycles: "Maximum number of ultrafix cycles",
    ultrafix_pause_seconds: "Pause duration between ultrafix cycles",
  };
  return descriptions[key];
}

/**
 * Displays all settings in a formatted table.
 */
function displaySettingsTable(settings: SystemSettings): void {
  const keys = Object.keys(settings) as SettingKey[];
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
function displaySettingDetail(key: SettingKey, value: unknown): void {
  console.log("");
  console.log("=".repeat(50));
  console.log(`Setting: ${key}`);
  console.log("=".repeat(50));
  console.log("");
  console.log(`Description: ${getSettingDescription(key)}`);
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
  $ propr setting update worker_concurrency 10           # Update a setting
`);

  // setting get
  setting
    .command("get")
    .description("View current system settings for ProPR backend")
    .option("-k, --key <key>", "Show only a specific setting key")
    .option("-j, --json", "Output settings as JSON")
    .addHelpText("after", `
Valid Setting Keys:
  worker_concurrency             Number of concurrent workers
  github_user_whitelist          Allowed GitHub users
  analysis_model_fast            Fast analysis model
  planner_context_model          Planner context model
  planner_generation_model       Planner generation model
  auto_followup_score_threshold  Auto-followup threshold (0-9)

Examples:
  $ propr setting get                                 # Show all settings
  $ propr setting get -k worker_concurrency           # Show specific setting
  $ propr setting get --json                          # Output as JSON
`)
    .action(
      async (options: { key?: string; json?: boolean }) => {
        try {
          const settings = await getSettings();

          if (options.json) {
            if (options.key) {
              if (!isValidSettingKey(options.key)) {
                console.error(`Error: Invalid setting key: ${options.key}`);
                console.log("");
                console.log("Valid setting keys:");
                for (const validKey of VALID_SETTING_KEYS) {
                  console.log(`  - ${validKey}`);
                }
                process.exit(1);
              }
              printOutput({ [options.key]: settings[options.key] }, true);
            } else {
              printOutput(settings, true);
            }
            return;
          }

          if (options.key) {
            if (!isValidSettingKey(options.key)) {
              console.error(`Error: Invalid setting key: ${options.key}`);
              console.log("");
              console.log("Valid setting keys:");
              for (const validKey of VALID_SETTING_KEYS) {
                console.log(`  - ${validKey}`);
              }
              process.exit(1);
            }
            displaySettingDetail(options.key, settings[options.key]);
            return;
          }

          console.log("Fetching system settings...");
          console.log("");
          displaySettingsTable(settings);
          console.log("");
          console.log(`Total: ${Object.keys(settings).length} setting(s)`);
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
  worker_concurrency           Number of concurrent workers (integer >= 1)
  github_user_whitelist        Comma-separated list of GitHub usernames
  analysis_model_fast          Model ID for fast analysis
  planner_context_model        Model ID for planner context
  planner_generation_model     Model ID for planner generation
  auto_followup_score_threshold  Score threshold 0-9 for auto-followup

Examples:
  $ propr setting update worker_concurrency 10
  $ propr setting update auto_followup_score_threshold 7
  $ propr setting update github_user_whitelist "user1,user2,user3"
  $ propr setting update analysis_model_fast claude-3-5-sonnet-20241022
`
    )
    .action(async (key: string, value: string) => {
      try {
        if (!isValidSettingKey(key)) {
          console.error(`Error: Invalid setting key: ${key}`);
          console.log("");
          console.log("Valid setting keys:");
          for (const validKey of VALID_SETTING_KEYS) {
            console.log(`  - ${validKey}: ${getSettingDescription(validKey)}`);
          }
          process.exit(1);
        }

        let parsedValue: number | string | string[] | boolean;
        try {
          parsedValue = parseSettingValue(key, value);
        } catch (parseError) {
          console.error(`Error: ${(parseError as Error).message}`);
          process.exit(1);
        }

        console.log(`Updating setting: ${key}...`);

        const result = await updateSetting(key, parsedValue);

        if (result.success) {
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
          console.log("");
          console.log(`Description: ${getSettingDescription(key as SettingKey)}`);
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

  return setting;
}
