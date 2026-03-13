/**
 * System Settings Commands
 *
 * CLI commands for managing system settings using the ProPR backend.
 * Provides the `get-settings` and `update-setting` commands.
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

/**
 * Formats a setting value for display.
 *
 * @param value - The setting value to format.
 * @returns A formatted string representation of the value.
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
 *
 * @param key - The setting key.
 * @returns A description of the setting.
 */
function getSettingDescription(key: SettingKey): string {
  const descriptions: Record<SettingKey, string> = {
    worker_concurrency: "Number of concurrent workers for processing tasks",
    github_user_whitelist: "GitHub usernames allowed to use the system",
    analysis_model_fast: "Model for fast analysis operations",
    planner_context_model: "Model for planner context generation",
    planner_generation_model: "Model for planner generation",
    auto_followup_score_threshold: "Score threshold (0-9) for auto-followup",
  };
  return descriptions[key] || key;
}

/**
 * Displays all settings in a formatted table.
 *
 * @param settings - The settings object to display.
 */
function displaySettingsTable(settings: SystemSettings): void {
  // Calculate column widths
  const keys = Object.keys(settings) as SettingKey[];
  const keyWidth = Math.max("Setting".length, ...keys.map((k) => k.length));
  const valueWidth = Math.max(
    "Value".length,
    ...keys.map((k) => formatValue(settings[k]).length)
  );

  // Print header
  const header = [
    "Setting".padEnd(keyWidth),
    "Value".padEnd(valueWidth),
  ].join("  ");

  console.log(header);
  console.log("-".repeat(header.length));

  // Print each setting
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
 *
 * @param key - The setting key.
 * @param value - The setting value.
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
 * Registers system settings commands on the given program.
 *
 * @param program - The Commander program to add commands to.
 */
export function registerSettingCommands(program: Command): void {
  // Get settings command
  program
    .command("get-settings")
    .description("View current system settings")
    .option("-k, --key <key>", "Show only a specific setting key")
    .option("-j, --json", "Output settings as JSON")
    .action(
      async (options: { key?: string; json?: boolean }) => {
        try {
          console.log("Fetching system settings...");

          const settings = await getSettings();

          // If JSON output requested
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
              console.log(JSON.stringify({ [options.key]: settings[options.key] }, null, 2));
            } else {
              console.log(JSON.stringify(settings, null, 2));
            }
            return;
          }

          // If specific key requested
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

          // Display all settings
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

  // Update setting command
  program
    .command("update-setting <key> <value>")
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
  $ propr update-setting worker_concurrency 10
  $ propr update-setting auto_followup_score_threshold 7
  $ propr update-setting github_user_whitelist "user1,user2,user3"
  $ propr update-setting analysis_model_fast claude-3-5-sonnet-20241022
`
    )
    .action(async (key: string, value: string) => {
      try {
        // Validate the key
        if (!isValidSettingKey(key)) {
          console.error(`Error: Invalid setting key: ${key}`);
          console.log("");
          console.log("Valid setting keys:");
          for (const validKey of VALID_SETTING_KEYS) {
            console.log(`  - ${validKey}: ${getSettingDescription(validKey)}`);
          }
          process.exit(1);
        }

        // Parse the value to the appropriate type
        let parsedValue: number | string | string[];
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
}
