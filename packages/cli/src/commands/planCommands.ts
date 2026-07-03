/**
 * Plan Management Commands
 *
 * CLI commands for managing plans using the ProPR backend.
 * Provides the `plan` command group with `list`, `create`, `get`, `delete`, and `abort` subcommands.
 */

import { Command } from "commander";
import {
  listPlans,
  createPlan,
  getPlan,
  deletePlan,
  abortPlan,
  generatePlan,
  finalizePlan,
  listPlanIssues,
  Plan,
  PlanSummary,
  PlanStatus,
} from "../api/index.js";
import { createConfigManager } from "../config/index.js";
import { resolveProject, ProjectResolutionError, printOutput } from "../utils/index.js";

/**
 * Formats a plan status for display with color hints.
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
 */
function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleString();
}

/**
 * Displays detailed plan information.
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
 */
async function confirm(message: string): Promise<boolean> {
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
 * Creates the `plan` command group.
 */
export function createPlanCommand(): Command {
  const plan = new Command("plan")
    .description("Manage implementation plans")
    .addHelpText("after", `
Examples:
  $ propr plan list                          # List all plans
  $ propr plan create "Add dark mode" -w     # Create and wait for generation
  $ propr plan get abc123                    # View plan details
  $ propr plan generate abc123 --wait        # Trigger generation for existing draft
  $ propr plan finalize abc123               # Create GitHub issues from plan
  $ propr plan issues abc123                 # List plan issues
  $ propr plan delete abc123                 # Delete a plan
  $ propr plan abort abc123                  # Abort generation
`);

  // plan list
  plan
    .command("list")
    .description("List all implementation plans for a project")
    .option("-p, --project <project>", "Target project (owner/repo)")
    .option("-j, --json", "Output as JSON for programmatic use")
    .addHelpText("after", `
Examples:
  $ propr plan list                    # Use default project
  $ propr plan list -p myorg/myrepo    # Specify project
  $ propr plan list --json             # JSON output
`)
    .action(async (options: { project?: string; json?: boolean }) => {
      try {
        const configManager = await createConfigManager();
        const project = resolveProject(options, configManager);

        const result = await listPlans(project);

        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        if (result.drafts.length === 0) {
          console.log(`No plans found for project: ${project}`);
          console.log("");
          console.log("To create a new plan, use:");
          console.log("  propr plan create \"<prompt>\"");
          return;
        }

        console.log(`Plans for ${project}:`);
        console.log("");

        const idWidth = Math.max(
          "ID".length,
          ...result.drafts.map((p: PlanSummary) => p.draft_id.length)
        );
        const nameWidth = Math.max(
          "Name".length,
          ...result.drafts.map((p: PlanSummary) => p.name.length)
        );
        const statusWidth = Math.max(
          "Status".length,
          ...result.drafts.map((p: PlanSummary) => p.status.length)
        );

        const header = `${"ID".padEnd(idWidth)}  ${"Name".padEnd(nameWidth)}  ${"Status".padEnd(statusWidth)}`;
        console.log(header);
        console.log("-".repeat(header.length));

        for (const p of result.drafts) {
          console.log(
            `${p.draft_id.padEnd(idWidth)}  ${p.name.padEnd(nameWidth)}  ${p.status.padEnd(statusWidth)}`
          );
        }

        console.log("");
        console.log(`Total: ${result.total} plan(s)`);

        if (result.hasMore) {
          console.log(`Showing page ${result.page} of results. More plans available.`);
        }
      } catch (error) {
        if (error instanceof ProjectResolutionError) {
          console.error(`Error: ${error.message}`);
          process.exit(1);
        }
        console.error(`Error fetching plans: ${(error as Error).message}`);
        process.exit(1);
      }
    });

  // plan create
  plan
    .command("create <prompt>")
    .description("Create a new implementation plan from a natural language prompt")
    .option("-p, --project <project>", "Target project (owner/repo)")
    .option("-b, --branch <branch>", "Target branch (default: main)", "main")
    .option("-w, --wait", "Wait for plan generation to complete")
    .addHelpText("after", `
Argument:
  prompt    Natural language description of what to implement

Examples:
  $ propr plan create "Add user authentication with JWT"
  $ propr plan create "Fix the login page styling" --wait
  $ propr plan create "Add dark mode" -b develop -p myorg/myrepo --wait
`)
    .action(async (prompt: string, options: { project?: string; branch: string; wait?: boolean }) => {
      try {
        const configManager = await createConfigManager();
        const project = resolveProject(options, configManager);

        console.log(`Creating plan for ${project}...`);

        const planResult = await createPlan(project, prompt, {
          contextConfig: {
            branch: options.branch,
          },
        });

        console.log(`Plan created with ID: ${planResult.draft_id}`);
        console.log(`Status: ${planResult.status}`);

        // Trigger generation
        console.log("Triggering plan generation...");
        await generatePlan(planResult.draft_id);

        if (!options.wait) {
          console.log("");
          console.log(`Generation started. Use 'propr plan get ${planResult.draft_id}' to check status.`);
          return;
        }

        console.log("");
        console.log("Waiting for plan generation to complete...");

        // "review" is the terminal success state after generation completes.
        // "draft" is only terminal if we already saw generation activity.
        const doneStatuses: PlanStatus[] = ["review", "approved", "failed", "executed", "merged", "pr_created"];
        const pollIntervalMs = 3000;
        const maxWaitMs = 600000;
        const startTime = Date.now();

        let currentPlan: Plan = planResult;
        let lastStatus = planResult.status;
        let sawGenerating = false;

        while (Date.now() - startTime < maxWaitMs) {
          await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));

          currentPlan = await getPlan(planResult.draft_id);

          if (currentPlan.status !== lastStatus) {
            console.log(`Status: ${formatStatus(currentPlan.status)}`);
            lastStatus = currentPlan.status;
          }

          if (currentPlan.status === "generating" || currentPlan.status === "refining") {
            sawGenerating = true;
          }

          if (doneStatuses.includes(currentPlan.status)) {
            break;
          }
          // "draft" after generation means it returned to draft (generation done)
          if (currentPlan.status === "draft" && sawGenerating) {
            break;
          }
        }

        console.log("");
        const isDone = doneStatuses.includes(currentPlan.status) || (currentPlan.status === "draft" && sawGenerating);
        if (currentPlan.status === "failed") {
          console.error("Plan generation failed.");
          process.exit(1);
        } else if (isDone) {
          console.log(`Plan generation completed.`);
          console.log(`Final status: ${formatStatus(currentPlan.status)}`);
          if (currentPlan.name) {
            console.log(`Name: ${currentPlan.name}`);
          }
        } else {
          console.log(`Timeout: Plan is still ${formatStatus(currentPlan.status)} after ${Math.round((Date.now() - startTime) / 1000)} seconds.`);
          console.log(`Plan ID: ${currentPlan.draft_id}`);
          console.log(`Use 'propr plan get ${currentPlan.draft_id}' to check status.`);
        }
      } catch (error) {
        if (error instanceof ProjectResolutionError) {
          console.error(`Error: ${error.message}`);
          process.exit(1);
        }
        console.error(`Error creating plan: ${(error as Error).message}`);
        process.exit(1);
      }
    });

  // plan get
  plan
    .command("get <draft-id>")
    .description("Get detailed information about a specific plan")
    .option("-j, --json", "Output as JSON for programmatic use")
    .addHelpText("after", `
Argument:
  draft-id    The unique identifier of the plan

Examples:
  $ propr plan get abc123-def456
  $ propr plan get abc123-def456 --json
`)
    .action(async (draftId: string, options: { json?: boolean }) => {
      try {
        const fetchedPlan = await getPlan(draftId);

        if (printOutput(fetchedPlan, options.json ?? false)) {
          return;
        }

        displayPlanDetails(fetchedPlan);
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

  // plan delete
  plan
    .command("delete <draft-id>")
    .description("Delete a plan from the system permanently")
    .option("-f, --force", "Skip confirmation prompt")
    .addHelpText("after", `
Argument:
  draft-id    The unique identifier of the plan to delete

Examples:
  $ propr plan delete abc123-def456           # With confirmation
  $ propr plan delete abc123-def456 --force   # Skip confirmation
`)
    .action(async (draftId: string, options: { force?: boolean }) => {
      try {
        let planName = draftId;
        try {
          const fetchedPlan = await getPlan(draftId);
          planName = fetchedPlan.name || fetchedPlan.task_title || draftId;
          console.log(`Plan: ${planName}`);
          console.log(`Repository: ${fetchedPlan.repository}`);
          console.log(`Status: ${formatStatus(fetchedPlan.status)}`);
          console.log("");
        } catch {
          console.log(`Plan ID: ${draftId}`);
          console.log("");
        }

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

  // plan abort
  plan
    .command("abort <draft-id>")
    .description("Abort ongoing LLM generation for a plan (only works for generating/refining plans)")
    .addHelpText("after", `
Argument:
  draft-id    The unique identifier of the plan with active generation

Note:
  This command only works for plans in 'generating' or 'refining' status.

Example:
  $ propr plan abort abc123-def456
`)
    .action(async (draftId: string) => {
      try {
        try {
          const fetchedPlan = await getPlan(draftId);
          if (fetchedPlan.status !== "generating" && fetchedPlan.status !== "refining") {
            console.log(`Plan status: ${formatStatus(fetchedPlan.status)}`);
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

  // plan generate
  plan
    .command("generate <draft-id>")
    .description("Trigger plan generation for an existing draft")
    .option("-w, --wait", "Wait for generation to complete")
    .addHelpText("after", `
Argument:
  draft-id    The unique identifier of the plan draft

Examples:
  $ propr plan generate abc123-def456
  $ propr plan generate abc123-def456 --wait
`)
    .action(async (draftId: string, options: { wait?: boolean }) => {
      try {
        console.log(`Triggering generation for plan ${draftId}...`);
        await generatePlan(draftId);
        console.log("Generation started.");

        if (!options.wait) {
          console.log(`Use 'propr plan get ${draftId}' to check status.`);
          return;
        }

        console.log("");
        console.log("Waiting for generation to complete...");

        const terminalStatuses: PlanStatus[] = ["draft", "review", "approved", "failed", "executed", "merged", "pr_created"];
        const pollIntervalMs = 3000;
        const maxWaitMs = 600000;
        const startTime = Date.now();
        let lastStatus = "generating" as PlanStatus;

        while (Date.now() - startTime < maxWaitMs) {
          await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));

          const currentPlan = await getPlan(draftId);

          if (currentPlan.status !== lastStatus) {
            console.log(`Status: ${formatStatus(currentPlan.status)}`);
            lastStatus = currentPlan.status;
          }

          if (terminalStatuses.includes(currentPlan.status)) {
            if (currentPlan.status === "failed") {
              console.error("Plan generation failed.");
              process.exit(1);
            }
            console.log("Generation completed.");
            return;
          }
        }

        console.log(`Timeout after ${Math.round((Date.now() - startTime) / 1000)} seconds.`);
      } catch (error) {
        console.error(`Error generating plan: ${(error as Error).message}`);
        process.exit(1);
      }
    });

  // plan finalize
  plan
    .command("finalize <draft-id>")
    .description("Finalize a plan by creating GitHub issues from its items")
    .option("-j, --json", "Output as JSON for programmatic use")
    .addHelpText("after", `
Argument:
  draft-id    The unique identifier of the plan to finalize

Example:
  $ propr plan finalize abc123-def456
`)
    .action(async (draftId: string, options: { json?: boolean }) => {
      try {
        console.log(`Finalizing plan ${draftId}...`);
        const result = await finalizePlan(draftId);

        if (printOutput(result, options.json ?? false)) {
          return;
        }

        if (result.alreadyExecuted) {
          console.log("Plan was already finalized.");
        } else {
          console.log(`Created ${result.issuesCreated} GitHub issue(s).`);
        }
      } catch (error) {
        console.error(`Error finalizing plan: ${(error as Error).message}`);
        process.exit(1);
      }
    });

  // plan issues
  plan
    .command("issues <draft-id>")
    .description("List GitHub issues created from a plan")
    .option("-j, --json", "Output as JSON for programmatic use")
    .addHelpText("after", `
Argument:
  draft-id    The unique identifier of the plan

Example:
  $ propr plan issues abc123-def456
  $ propr plan issues abc123-def456 --json
`)
    .action(async (draftId: string, options: { json?: boolean }) => {
      try {
        const issues = await listPlanIssues(draftId);

        if (printOutput(issues, options.json ?? false)) {
          return;
        }

        if (issues.length === 0) {
          console.log("No issues found for this plan.");
          console.log("Use 'propr plan finalize' to create issues from plan items.");
          return;
        }

        console.log(`Issues for plan ${draftId}:`);
        console.log("");

        const numWidth = Math.max("Issue".length, ...issues.map((i) => String(i.issue_number).length));
        const statusWidth = Math.max("Status".length, ...issues.map((i) => i.status.length));
        const modelWidth = Math.max("Model".length, ...issues.map((i) => (i.model_name || "-").length));

        const header = `${"Issue".padEnd(numWidth)}  ${"Status".padEnd(statusWidth)}  ${"Model".padEnd(modelWidth)}  Task ID`;
        console.log(header);
        console.log("-".repeat(header.length + 20));

        for (const issue of issues) {
          console.log(
            `#${String(issue.issue_number).padEnd(numWidth - 1)}  ${issue.status.padEnd(statusWidth)}  ${(issue.model_name || "-").padEnd(modelWidth)}  ${issue.task_id || "-"}`
          );
        }

        console.log("");
        console.log(`Total: ${issues.length} issue(s)`);
      } catch (error) {
        console.error(`Error listing plan issues: ${(error as Error).message}`);
        process.exit(1);
      }
    });

  return plan;
}
