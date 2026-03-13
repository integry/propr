/**
 * Plan Management Commands
 *
 * CLI commands for managing plans using the ProPR backend.
 * Provides the `get-plan`, `delete-plan`, and `abort-plan` commands.
 */

import { Command } from "commander";
import {
  getPlan,
  deletePlan,
  abortPlan,
  Plan,
  PlanStatus,
} from "../api/index.js";

/**
 * Formats a plan status for display with color hints.
 *
 * @param status - The plan status.
 * @returns A formatted status string.
 */
function formatStatus(status: PlanStatus): string {
  const statusMap: Record<PlanStatus, string> = {
    draft: "Draft",
    review: "Review",
    generating: "Generating",
    refining: "Refining",
    executed: "Executed",
    approved: "Approved",
    merged: "Merged",
    pr_created: "PR Created",
    failed: "Failed",
  };
  return statusMap[status] || status;
}

/**
 * Formats a date string for display.
 *
 * @param dateStr - The ISO date string.
 * @returns A formatted date string.
 */
function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleString();
}

/**
 * Displays detailed plan information.
 *
 * @param plan - The plan to display.
 */
function displayPlanDetails(plan: Plan): void {
  console.log("");
  console.log("=".repeat(60));
  console.log("Plan Details");
  console.log("=".repeat(60));
  console.log("");

  console.log(`ID:          ${plan.draft_id}`);
  console.log(`Name:        ${plan.name || plan.task_title || "(Untitled)"}`);
  console.log(`Repository:  ${plan.repository}`);
  console.log(`Status:      ${formatStatus(plan.status)}`);
  console.log(`Created:     ${formatDate(plan.created_at)}`);
  console.log(`Updated:     ${formatDate(plan.updated_at)}`);

  if (plan.initial_prompt) {
    console.log("");
    console.log("Initial Prompt:");
    console.log("-".repeat(40));
    console.log(plan.initial_prompt);
  }

  // Display plan items (tasks/issues)
  if (plan.plan_json && Array.isArray(plan.plan_json) && plan.plan_json.length > 0) {
    console.log("");
    console.log("Plan Items:");
    console.log("-".repeat(40));

    for (let i = 0; i < plan.plan_json.length; i++) {
      const item = plan.plan_json[i] as Record<string, unknown>;
      const title = item.title || item.name || `Item ${i + 1}`;
      const description = item.description || "";
      console.log(`${i + 1}. ${title}`);
      if (description) {
        // Truncate long descriptions
        const truncated = description.toString().length > 100
          ? description.toString().substring(0, 100) + "..."
          : description;
        console.log(`   ${truncated}`);
      }
    }
  }

  // Display attachments if any
  if (plan.attachments && plan.attachments.length > 0) {
    console.log("");
    console.log("Attachments:");
    console.log("-".repeat(40));
    for (const attachment of plan.attachments) {
      console.log(`- ${attachment.filename} (${attachment.contentType}, ${attachment.size} bytes)`);
    }
  }

  // Display chat history count if any
  if (plan.chat_history && plan.chat_history.length > 0) {
    console.log("");
    console.log(`Chat History: ${plan.chat_history.length} message(s)`);
  }

  console.log("");
  console.log("=".repeat(60));
}

/**
 * Prompts the user for confirmation.
 *
 * @param message - The confirmation message.
 * @returns A promise resolving to true if confirmed, false otherwise.
 */
async function confirm(message: string): Promise<boolean> {
  // Use readline for simple confirmation
  const readline = await import("readline");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(`${message} (y/N): `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === "y" || answer.toLowerCase() === "yes");
    });
  });
}

/**
 * Registers plan management commands on the given program.
 *
 * @param program - The Commander program to add commands to.
 */
export function registerPlanCommands(program: Command): void {
  // Get plan command
  program
    .command("get-plan <draft-id>")
    .description("Get detailed information about a specific plan")
    .addHelpText("after", `
Argument:
  draft-id    The unique identifier of the plan

Example:
  $ propr get-plan abc123-def456
`)
    .action(async (draftId: string) => {
      try {
        console.log(`Fetching plan ${draftId}...`);

        const plan = await getPlan(draftId);
        displayPlanDetails(plan);
      } catch (error) {
        const errorMessage = (error as Error).message;
        if (errorMessage.includes("404") || errorMessage.includes("not found")) {
          console.error(`Error: Plan not found: ${draftId}`);
        } else if (errorMessage.includes("401") || errorMessage.includes("unauthorized")) {
          console.error("Error: Unauthorized. Please run 'propr login' first.");
        } else if (errorMessage.includes("403") || errorMessage.includes("forbidden")) {
          console.error("Error: Access denied. You do not have permission to view this plan.");
        } else {
          console.error(`Error fetching plan: ${errorMessage}`);
        }
        process.exit(1);
      }
    });

  // Delete plan command
  program
    .command("delete-plan <draft-id>")
    .description("Delete a plan from the system permanently")
    .option("-f, --force", "Skip confirmation prompt")
    .addHelpText("after", `
Argument:
  draft-id    The unique identifier of the plan to delete

Examples:
  $ propr delete-plan abc123-def456           # With confirmation
  $ propr delete-plan abc123-def456 --force   # Skip confirmation
`)
    .action(async (draftId: string, options: { force?: boolean }) => {
      try {
        // Fetch the plan first to show what will be deleted
        let planName = draftId;
        try {
          const plan = await getPlan(draftId);
          planName = plan.name || plan.task_title || draftId;
          console.log(`Plan: ${planName}`);
          console.log(`Repository: ${plan.repository}`);
          console.log(`Status: ${formatStatus(plan.status)}`);
          console.log("");
        } catch {
          // If we can't fetch the plan, continue with deletion using just the ID
          console.log(`Plan ID: ${draftId}`);
          console.log("");
        }

        // Confirm deletion unless --force is used
        if (!options.force) {
          const confirmed = await confirm(`Are you sure you want to delete this plan?`);
          if (!confirmed) {
            console.log("Deletion cancelled.");
            return;
          }
        }

        console.log(`Deleting plan ${draftId}...`);
        await deletePlan(draftId);
        console.log("Plan deleted successfully.");
      } catch (error) {
        const errorMessage = (error as Error).message;
        if (errorMessage.includes("404") || errorMessage.includes("not found")) {
          console.error(`Error: Plan not found: ${draftId}`);
        } else if (errorMessage.includes("401") || errorMessage.includes("unauthorized")) {
          console.error("Error: Unauthorized. Please run 'propr login' first.");
        } else if (errorMessage.includes("403") || errorMessage.includes("forbidden")) {
          console.error("Error: Access denied. You do not have permission to delete this plan.");
        } else {
          console.error(`Error deleting plan: ${errorMessage}`);
        }
        process.exit(1);
      }
    });

  // Abort plan command
  program
    .command("abort-plan <draft-id>")
    .description("Abort ongoing LLM generation for a plan (only works for generating/refining plans)")
    .addHelpText("after", `
Argument:
  draft-id    The unique identifier of the plan with active generation

Note:
  This command only works for plans in 'generating' or 'refining' status.

Example:
  $ propr abort-plan abc123-def456
`)
    .action(async (draftId: string) => {
      try {
        // Optionally check the plan status first
        try {
          const plan = await getPlan(draftId);
          if (plan.status !== "generating" && plan.status !== "refining") {
            console.log(`Plan status: ${formatStatus(plan.status)}`);
            console.log("");
            console.log("Warning: This plan is not currently generating or refining.");
            console.log("The abort command is only effective for plans in 'generating' or 'refining' status.");
            console.log("");
          }
        } catch {
          // If we can't fetch the plan, continue with abort attempt
        }

        console.log(`Aborting generation for plan ${draftId}...`);
        const result = await abortPlan(draftId);

        if (result.success) {
          console.log(result.message || "Generation aborted successfully.");
        } else {
          console.error(`Failed to abort: ${result.message}`);
          process.exit(1);
        }
      } catch (error) {
        const errorMessage = (error as Error).message;
        if (errorMessage.includes("404") || errorMessage.includes("not found")) {
          console.error(`Error: Plan not found: ${draftId}`);
        } else if (errorMessage.includes("400")) {
          console.error("Error: Plan is not in a state that can be aborted (must be 'generating' or 'refining').");
        } else if (errorMessage.includes("401") || errorMessage.includes("unauthorized")) {
          console.error("Error: Unauthorized. Please run 'propr login' first.");
        } else if (errorMessage.includes("403") || errorMessage.includes("forbidden")) {
          console.error("Error: Access denied. You do not have permission to abort this plan.");
        } else {
          console.error(`Error aborting plan: ${errorMessage}`);
        }
        process.exit(1);
      }
    });
}
