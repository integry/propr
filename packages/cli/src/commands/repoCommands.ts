import { describeGitHubAttachmentCapacity, isGitHubLogin, resolveGitHubAttachmentCapacity, type GitHubAttachmentPlanOverride } from "@propr/shared";
/**
 * Repository Management Commands
 *
 * CLI commands for managing monitored repositories using the ProPR backend.
 * Provides the `repo` command group with `list`, `add`, `remove`, `toggle`, `index`, `status`, and `validate` subcommands.
 */

import { Command } from "commander";
import { createRepoValidateCommand } from "./repoValidate.js";
import {
  getRepos,
  getSettings,
  addRepo,
  removeRepo,
  updateRepo,
  triggerIndexing,
  getIndexingStatus,
  MonitoredRepo,
  RepositoryIndexingStatus,
  VisualPreviewSettings,
} from "../api/index.js";
import { printOutput } from "../utils/index.js";
import { classifyApiError, presentApiError } from "../utils/apiErrorPresentation.js";

/**
 * Formats the enabled status for display.
 */
function formatEnabled(enabled: boolean): string {
  return enabled ? "Enabled" : "Disabled";
}

function parseVisualPreviewTypes(value: string | undefined): VisualPreviewSettings['types'] {
  if (!value) return ['image'];
  const values = [...new Set(value.split(',').map(type => type.trim().toLowerCase()).filter(Boolean))];
  if (values.length === 0 || values.some(type => type !== 'image' && type !== 'video')) {
    throw new Error('Preview types must be a comma-separated list containing image and/or video');
  }
  return values as VisualPreviewSettings['types'];
}

function parseAttachmentPlan(value: string): GitHubAttachmentPlanOverride {
  if (value !== 'auto' && value !== 'free' && value !== 'paid') {
    throw new Error('GitHub attachment plan must be auto, free, or paid');
  }
  return value;
}

function formatVisualPreview(settings: VisualPreviewSettings | undefined): string {
  const capacity = resolveGitHubAttachmentCapacity(settings?.githubAttachmentPlan, settings?.githubAttachmentCapacity?.detectedPlan);
  return `${settings?.enabled ? settings.types.join('+') : 'Disabled'}; ${capacity.override}: ${describeGitHubAttachmentCapacity(capacity)}`;
}

/**
 * Parses `--auto-resolve-conflicts <on|off|inherit>`; `inherit` (null) clears
 * the repository override so the instance default applies.
 */
export function parseAutoResolveConflicts(value: string): boolean | null {
  const normalized = value.trim().toLowerCase();
  if (["on", "true", "always", "enabled"].includes(normalized)) return true;
  if (["off", "false", "never", "disabled"].includes(normalized)) return false;
  if (["inherit", "default"].includes(normalized)) return null;
  throw new Error("Auto-resolve conflicts must be on, off, or inherit");
}

/** Shows the repository override, or the inherited instance default when known. */
export function formatAutoResolveConflicts(override: boolean | null | undefined, instanceDefault?: boolean): string {
  if (typeof override === "boolean") return override ? "On" : "Off";
  return instanceDefault === undefined ? "Inherit" : `Inherit (${instanceDefault ? "On" : "Off"})`;
}

/** Parses an explicit `on`/`off` flag value; any other string is an error, never truthy. */
export function parseOnOff(value: string, flag: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (normalized === "on") return true;
  if (normalized === "off") return false;
  throw new Error(`${flag} must be on or off`);
}

/** Parses `--auto-assign-to <login|none>`; `none` (null) assigns the issue author again. */
export function parseAutoAssignTo(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.toLowerCase() === "none") return null;
  const login = trimmed.replace(/^@/, "");
  if (!isGitHubLogin(login)) throw new Error("--auto-assign-to must be a GitHub login or none");
  return login;
}

export interface AutoAssignFlags {
  autoAssign?: string;
  autoAssignTo?: string;
  autoAssignReview?: string;
}

/** Only flags the user supplied are sent, so the server keeps every other stored value. */
export function parseAutoAssignFlags(options: AutoAssignFlags): {
  autoAssignPullRequests?: boolean;
  autoAssignDefaultAssignee?: string | null;
  autoAssignRequestReview?: boolean;
} {
  return {
    ...(options.autoAssign !== undefined && { autoAssignPullRequests: parseOnOff(options.autoAssign, "--auto-assign") }),
    ...(options.autoAssignTo !== undefined && { autoAssignDefaultAssignee: parseAutoAssignTo(options.autoAssignTo) }),
    ...(options.autoAssignReview !== undefined && { autoAssignRequestReview: parseOnOff(options.autoAssignReview, "--auto-assign-review") }),
  };
}

export function hasAutoAssignFlags(options: AutoAssignFlags): boolean {
  return options.autoAssign !== undefined || options.autoAssignTo !== undefined || options.autoAssignReview !== undefined;
}

/** Shows whether pull requests are assigned, to whom, and whether a review is requested. */
export function formatAutoAssign(repo: Pick<MonitoredRepo, "autoAssignPullRequests" | "autoAssignDefaultAssignee" | "autoAssignRequestReview">): string {
  if (repo.autoAssignPullRequests !== true) return "Off";
  const assignee = repo.autoAssignDefaultAssignee ? `@${repo.autoAssignDefaultAssignee}` : "issue author";
  return `On (${assignee}${repo.autoAssignRequestReview === true ? ", review" : ""})`;
}

/** Best-effort read of the instance default; listing still works without it. */
async function loadInstanceAutoResolveDefault(): Promise<boolean | undefined> {
  try {
    const settings = await getSettings() as { auto_resolve_merge_conflicts?: unknown };
    return typeof settings.auto_resolve_merge_conflicts === "boolean" ? settings.auto_resolve_merge_conflicts : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Truncates a string to a maximum length.
 */
function truncate(str: string | null | undefined, maxLen: number): string {
  if (!str) return "";
  if (str.length <= maxLen) return str;
  return str.substring(0, maxLen - 3) + "...";
}

/**
 * Formats the indexing status for display.
 */
function formatIndexingStatus(status: string): string {
  switch (status) {
    case "indexing":
      return "Indexing";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "idle":
    default:
      return "Idle";
  }
}

/**
 * Formats token usage for display.
 */
function formatTokens(inputTokens: number, outputTokens: number): string {
  const total = inputTokens + outputTokens;
  if (total === 0) return "-";

  const formatNum = (n: number): string => {
    if (n >= 1000) {
      return `${(n / 1000).toFixed(1)}K`;
    }
    return n.toString();
  };

  return `${formatNum(inputTokens)}/${formatNum(outputTokens)}`;
}

/**
 * Displays a table of repository indexing statuses with clean formatting.
 */
function displayIndexingStatusTable(statuses: RepositoryIndexingStatus[]): void {
  const repoWidth = Math.max(
    "Repository".length,
    ...statuses.map((s) => truncate(s.full_name, 40).length)
  );
  const branchWidth = Math.max(
    "Branch".length,
    ...statuses.map((s) => truncate(s.branch, 15).length || 1)
  );
  const statusWidth = Math.max(
    "Status".length,
    ...statuses.map((s) => formatIndexingStatus(s.indexing_status).length)
  );
  const progressWidth = Math.max(
    "Progress".length,
    10
  );
  const tokensWidth = Math.max(
    "Tokens (In/Out)".length,
    ...statuses.map((s) => {
      if (s.progress) {
        return formatTokens(s.progress.inputTokens, s.progress.outputTokens).length;
      }
      return 1;
    })
  );

  const header = [
    "Repository".padEnd(repoWidth),
    "Branch".padEnd(branchWidth),
    "Status".padEnd(statusWidth),
    "Progress".padEnd(progressWidth),
    "Tokens (In/Out)".padEnd(tokensWidth),
  ].join("  ");

  console.log(header);
  console.log("-".repeat(header.length));

  for (const status of statuses) {
    let progressStr = "-";
    if (status.progress) {
      progressStr = `${status.progress.percentComplete.toFixed(1)}%`;
    } else if (status.indexing_status === "completed") {
      progressStr = "100%";
    }

    const tokensStr = status.progress
      ? formatTokens(status.progress.inputTokens, status.progress.outputTokens)
      : "-";

    const row = [
      truncate(status.full_name, 40).padEnd(repoWidth),
      (truncate(status.branch, 15) || "-").padEnd(branchWidth),
      formatIndexingStatus(status.indexing_status).padEnd(statusWidth),
      progressStr.padEnd(progressWidth),
      tokensStr.padEnd(tokensWidth),
    ].join("  ");

    console.log(row);
  }
}

/**
 * Displays a table of repositories with clean formatting.
 */
function displayReposTable(repos: MonitoredRepo[], autoResolveDefault?: boolean): void {
  const nameWidth = Math.max(
    "Repository".length,
    ...repos.map((r) => truncate(r.name, 40).length)
  );
  const aliasWidth = Math.max(
    "Alias".length,
    ...repos.map((r) => truncate(r.alias, 20).length || 1)
  );
  const branchWidth = Math.max(
    "Branch".length,
    ...repos.map((r) => truncate(r.baseBranch, 20).length || 1)
  );
  const statusWidth = Math.max(
    "Status".length,
    ...repos.map((r) => formatEnabled(r.enabled).length)
  );
  const autoCiFollowupWidth = Math.max(
    "Auto CI follow-up".length,
    ...repos.map((r) => formatEnabled(r.autoFollowupOnFailedCi).length)
  );
  const notificationsWidth = Math.max(
    "Notifications".length,
    ...repos.map((r) => formatEnabled(r.notificationsEnabled !== false).length)
  );
  const autoResolveWidth = Math.max(
    "Auto-resolve conflicts".length,
    ...repos.map((r) => formatAutoResolveConflicts(r.autoResolveMergeConflicts, autoResolveDefault).length)
  );
  const autoAssignWidth = Math.max(
    "Auto-assign PRs".length,
    ...repos.map((r) => formatAutoAssign(r).length)
  );
  const visualPreviewWidth = Math.max(
    "Visual previews".length,
    ...repos.map((r) => formatVisualPreview(r.visualPreview).length)
  );

  const header = [
    "Repository".padEnd(nameWidth),
    "Alias".padEnd(aliasWidth),
    "Branch".padEnd(branchWidth),
    "Status".padEnd(statusWidth),
    "Auto CI follow-up".padEnd(autoCiFollowupWidth),
    "Notifications".padEnd(notificationsWidth),
    "Auto-resolve conflicts".padEnd(autoResolveWidth),
    "Auto-assign PRs".padEnd(autoAssignWidth),
    "Visual previews".padEnd(visualPreviewWidth),
  ].join("  ");

  console.log(header);
  console.log("-".repeat(header.length));

  for (const repo of repos) {
    const row = [
      truncate(repo.name, 40).padEnd(nameWidth),
      (truncate(repo.alias, 20) || "-").padEnd(aliasWidth),
      (truncate(repo.baseBranch, 20) || "-").padEnd(branchWidth),
      formatEnabled(repo.enabled).padEnd(statusWidth),
      formatEnabled(repo.autoFollowupOnFailedCi).padEnd(autoCiFollowupWidth),
      formatEnabled(repo.notificationsEnabled !== false).padEnd(notificationsWidth),
      formatAutoResolveConflicts(repo.autoResolveMergeConflicts, autoResolveDefault).padEnd(autoResolveWidth),
      formatAutoAssign(repo).padEnd(autoAssignWidth),
      formatVisualPreview(repo.visualPreview).padEnd(visualPreviewWidth),
    ].join("  ");

    console.log(row);
  }
}

/**
 * Creates the `repo` command group.
 */
export function createRepoCommand(): Command {
  const repo = new Command("repo")
    .description("Manage monitored repositories")
    .addHelpText("after", `
Examples:
  $ propr repo list                              # List repositories
  $ propr repo add myorg/myrepo                  # Add a repository
  $ propr repo remove myorg/myrepo               # Remove a repository
  $ propr repo toggle myorg/myrepo --enable      # Enable monitoring
  $ propr repo index myorg/myrepo                # Trigger indexing
  $ propr repo status                            # View indexing status
  $ propr repo validate                          # Check .propr/pr-template.md in this checkout
`);
  repo.addCommand(createRepoValidateCommand());

  // repo list
  repo
    .command("list")
    .description("List all repositories being monitored by ProPR")
    .option("-j, --json", "Output as JSON for programmatic use")
    .addHelpText("after", `
Examples:
  $ propr repo list
  $ propr repo list --json
`)
    .action(async (options: { json?: boolean }) => {
      try {
        const result = await getRepos();

        if (printOutput(result, options.json ?? false)) {
          return;
        }

        console.log("Fetching monitored repositories...");

        if (result.repos_to_monitor.length === 0) {
          console.log("");
          console.log("No repositories are currently being monitored.");
          console.log("");
          console.log("To add a repository, use:");
          console.log("  propr repo add <owner/repo>");
          return;
        }

        console.log("");
        displayReposTable(result.repos_to_monitor, await loadInstanceAutoResolveDefault());

        console.log("");
        console.log(`Total: ${result.repos_to_monitor.length} repository(ies)`);
      } catch (error) {
        presentApiError(error, {
          forbiddenMessage: "Error: Access denied. You do not have permission to view repositories.",
          fallbackMessage: (message) => `Error listing repositories: ${message}`,
        });
        process.exit(1);
      }
    });

  // repo add
  repo
    .command("add <fullName>")
    .description("Add a repository to the monitored list for ProPR")
    .option("-a, --alias <alias>", "Display alias for the repository")
    .option("-b, --branch <branch>", "Base branch name (default: main/master)")
    .option("--auto-ci-followup", "Enable automatic follow-up when CI fails (default: off)")
    .option("--no-notifications", "Do not generate Inbox or push notifications for this repository (default: on)")
    .option("--auto-resolve-conflicts <mode>", "Merge-conflict auto-resolution: on, off, or inherit the instance default (default: inherit)")
    .option("--auto-assign <on|off>", "Assign ProPR pull requests automatically (default: off)")
    .option("--auto-assign-to <login|none>", "GitHub login assigned instead of the issue author; none uses the issue author")
    .option("--auto-assign-review <on|off>", "Also request a GitHub review from the assigned user (default: off)")
    .option("--visual-previews", "Enable visual previews for user-visible changes")
    .option("--github-attachment-plan <plan>", "GitHub attachment capacity: auto, free, paid (default: auto)")
    .option("--preview-types <types>", "Comma-separated preview types: image,video")
    .option("--preview-instructions <text>", "Additional visual capture instructions")
    .addHelpText("after", `
Argument:
  fullName    Repository in owner/repo format

Examples:
  $ propr repo add myorg/myrepo
  $ propr repo add myorg/myrepo -a "My Project" -b develop
  $ propr repo add myorg/myrepo --auto-ci-followup
  $ propr repo add myorg/myrepo --no-notifications
  $ propr repo add myorg/myrepo --auto-resolve-conflicts on
  $ propr repo add myorg/myrepo --auto-assign on --auto-assign-to octocat --auto-assign-review on
  $ propr repo add myorg/myrepo --visual-previews --preview-types image,video
`)
    .action(
      async (
        fullName: string,
        options: AutoAssignFlags & { alias?: string; branch?: string; autoCiFollowup?: boolean; notifications?: boolean; autoResolveConflicts?: string; visualPreviews?: boolean; previewTypes?: string; previewInstructions?: string; githubAttachmentPlan?: string },
        command: Command
      ) => {
        try {
          if (!fullName.includes("/")) {
            console.error(
              "Error: Repository name must be in 'owner/repo' format."
            );
            console.log("");
            console.log("Example: propr repo add integry/gitfix");
            process.exit(1);
          }

          const parts = fullName.split("/");
          if (parts.length !== 2 || !parts[0] || !parts[1]) {
            console.error(
              "Error: Invalid repository format. Expected 'owner/repo'."
            );
            process.exit(1);
          }

          console.log(`Adding repository: ${fullName}...`);

          // Commander defaults --no-notifications to true; only send an explicit
          // value when the flag was given so the server can inherit the stored
          // repository-wide setting.
          const notificationsEnabled = command.getOptionValueSource("notifications") === "cli"
            ? options.notifications !== false
            : undefined;
          const previewRequested = options.visualPreviews === true || options.previewTypes !== undefined || options.previewInstructions !== undefined;
          const autoResolveMergeConflicts = options.autoResolveConflicts === undefined
            ? undefined
            : parseAutoResolveConflicts(options.autoResolveConflicts);
          const autoAssign = parseAutoAssignFlags(options);

          const result = await addRepo(fullName, {
            alias: options.alias,
            baseBranch: options.branch,
            enabled: true,
            autoFollowupOnFailedCi: options.autoCiFollowup ?? false,
            notificationsEnabled,
            autoResolveMergeConflicts,
            ...autoAssign,
            visualPreview: {
              ...(options.githubAttachmentPlan !== undefined ? { githubAttachmentPlan: parseAttachmentPlan(options.githubAttachmentPlan) } : {}),
              enabled: previewRequested,
              types: parseVisualPreviewTypes(options.previewTypes),
              ...(options.previewInstructions?.trim() ? { instructions: options.previewInstructions.trim() } : {})
            },
          });

          if (result.success) {
            console.log("");
            console.log(`Successfully added repository: ${fullName}`);
            if (options.alias) {
              console.log(`  Alias: ${options.alias}`);
            }
            if (options.branch) {
              console.log(`  Base branch: ${options.branch}`);
            }
            console.log(
              `  Automatic CI follow-up: ${formatEnabled(options.autoCiFollowup ?? false)}`
            );
            const savedRepo = result.repos_to_monitor.find((r) => r.name.toLowerCase() === fullName.toLowerCase());
            console.log(`  Notifications: ${formatEnabled((savedRepo?.notificationsEnabled ?? notificationsEnabled) !== false)}`);
            console.log(`  Auto-resolve merge conflicts: ${formatAutoResolveConflicts(savedRepo?.autoResolveMergeConflicts ?? autoResolveMergeConflicts)}`);
            console.log(`  Auto-assign pull requests: ${formatAutoAssign(savedRepo ?? autoAssign)}`);
            console.log(`  Visual previews: ${formatVisualPreview({
              ...(options.githubAttachmentPlan !== undefined ? { githubAttachmentPlan: parseAttachmentPlan(options.githubAttachmentPlan) } : {}),
              enabled: previewRequested,
              types: parseVisualPreviewTypes(options.previewTypes)
            })}`);
            console.log("");
            console.log(
              `Total monitored repositories: ${result.repos_to_monitor.length}`
            );
          } else {
            console.error("Failed to add repository.");
            process.exit(1);
          }
        } catch (error) {
          const classification = classifyApiError(error);
          const errorMessage = classification.message;
          if (
            classification.kind === "unauthorized" ||
            classification.kind === "forbidden"
          ) {
            presentApiError(error, {
              forbiddenMessage: "Error: Access denied. You do not have permission to add repositories.",
              fallbackMessage: `Error adding repository: ${errorMessage}`,
            });
          } else if (
            (classification.status === undefined || classification.status === 409) &&
            errorMessage.includes("already being monitored")
          ) {
            console.error(`Error: Repository "${fullName}" is already being monitored.`);
            console.log("");
            console.log("To update the repository settings, you can:");
            console.log(`  1. Remove it first: propr repo remove ${fullName}`);
            console.log(`  2. Add it again with new options: propr repo add ${fullName} [options]`);
          } else {
            presentApiError(error, {
              forbiddenMessage: "Error: Access denied. You do not have permission to add repositories.",
              fallbackMessage: `Error adding repository: ${errorMessage}`,
            });
          }
          process.exit(1);
        }
      }
    );

  // repo remove
  repo
    .command("remove <fullName>")
    .description("Remove a repository from the monitored list")
    .addHelpText("after", `
Argument:
  fullName    Repository in owner/repo format

Example:
  $ propr repo remove myorg/myrepo
`)
    .action(async (fullName: string) => {
      try {
        if (!fullName.includes("/")) {
          console.error(
            "Error: Repository name must be in 'owner/repo' format."
          );
          console.log("");
          console.log("Example: propr repo remove integry/gitfix");
          process.exit(1);
        }

        console.log(`Removing repository: ${fullName}...`);

        const result = await removeRepo(fullName);

        if (result.success) {
          console.log("");
          console.log(`Successfully removed repository: ${fullName}`);
          console.log("");
          console.log(
            `Remaining monitored repositories: ${result.repos_to_monitor.length}`
          );
        } else {
          console.error("Failed to remove repository.");
          process.exit(1);
        }
      } catch (error) {
        const classification = classifyApiError(error);
        const errorMessage = classification.message;
        if (
          classification.kind === "unauthorized" ||
          classification.kind === "forbidden"
        ) {
          presentApiError(error, {
            forbiddenMessage: "Error: Access denied. You do not have permission to remove repositories.",
            fallbackMessage: `Error removing repository: ${errorMessage}`,
          });
        } else if (
          (classification.status === undefined || classification.status === 404) &&
          errorMessage.includes("not being monitored")
        ) {
          console.error(`Error: Repository "${fullName}" is not being monitored.`);
          console.log("");
          console.log("Use 'propr repo list' to see currently monitored repositories.");
        } else {
          presentApiError(error, {
            forbiddenMessage: "Error: Access denied. You do not have permission to remove repositories.",
            fallbackMessage: `Error removing repository: ${errorMessage}`,
          });
        }
        process.exit(1);
      }
    });

  // repo toggle
  repo
    .command("toggle <fullName>")
    .description("Update monitoring, automatic CI follow-up, notifications, merge-conflict auto-resolution, GitHub PR template fallback, automatic pull request assignment, or visual previews for a repository")
    .option("--enable", "Enable monitoring for the repository")
    .option("--disable", "Disable monitoring for the repository")
    .option("--auto-ci-followup", "Enable automatic follow-up when CI fails")
    .option("--no-auto-ci-followup", "Disable automatic follow-up when CI fails")
    .option("--notifications", "Generate Inbox and push notifications for the repository")
    .option("--no-notifications", "Stop generating Inbox and push notifications for the repository")
    .option("--auto-resolve-conflicts <mode>", "Merge-conflict auto-resolution for every branch of the repository: on, off, or inherit the instance default")
    .option("--github-pr-template", "Append the repository's GitHub pull request template when it has no .propr/pr-template.md (default)")
    .option("--no-github-pr-template", "Never append the repository's GitHub pull request template to PR descriptions")
    .option("--auto-assign <on|off>", "Assign ProPR pull requests automatically for every branch of the repository")
    .option("--auto-assign-to <login|none>", "GitHub login assigned instead of the issue author; none uses the issue author again")
    .option("--auto-assign-review <on|off>", "Also request a GitHub review from the assigned user")
    .option("--visual-previews", "Enable visual previews")
    .option("--no-visual-previews", "Disable visual previews")
    .option("--github-attachment-plan <plan>", "GitHub attachment capacity: auto, free, paid (default: auto)")
    .option("--preview-types <types>", "Comma-separated preview types: image,video")
    .option("--preview-instructions <text>", "Replace visual capture instructions")
    .addHelpText("after", `
Argument:
  fullName    Repository in owner/repo format

Note:
  Specify at least one monitoring, automatic CI follow-up, notification, merge-conflict auto-resolution, GitHub PR template, automatic assignment, or visual preview option.

Examples:
  $ propr repo toggle myorg/myrepo --enable
  $ propr repo toggle myorg/myrepo --disable
  $ propr repo toggle myorg/myrepo --auto-ci-followup
  $ propr repo toggle myorg/myrepo --no-auto-ci-followup
  $ propr repo toggle myorg/myrepo --no-notifications
  $ propr repo toggle myorg/myrepo --auto-resolve-conflicts inherit
  $ propr repo toggle myorg/myrepo --no-github-pr-template
  $ propr repo toggle myorg/myrepo --auto-assign on --auto-assign-to none
  $ propr repo toggle myorg/myrepo --visual-previews --preview-types image,video
`)
    .action(
      async (
        fullName: string,
        options: AutoAssignFlags & { enable?: boolean; disable?: boolean; autoCiFollowup?: boolean; notifications?: boolean; autoResolveConflicts?: string; githubPrTemplate?: boolean; visualPreviews?: boolean; previewTypes?: string; previewInstructions?: string; githubAttachmentPlan?: string }
      ) => {
        try {
          if (options.enable && options.disable) {
            console.error(
              "Error: Cannot specify both --enable and --disable."
            );
            process.exit(1);
          }

          if (!options.enable && !options.disable && options.autoCiFollowup === undefined && options.notifications === undefined && options.autoResolveConflicts === undefined && options.githubPrTemplate === undefined && options.visualPreviews === undefined && options.previewTypes === undefined && options.previewInstructions === undefined && options.githubAttachmentPlan === undefined && !hasAutoAssignFlags(options)) {
            console.error(
              "Error: Must specify a monitoring, automatic CI follow-up, notification, merge-conflict auto-resolution, GitHub PR template, automatic assignment, or visual preview option."
            );
            console.log("");
            console.log("Usage:");
            console.log(`  propr repo toggle ${fullName} --enable`);
            console.log(`  propr repo toggle ${fullName} --disable`);
            console.log(`  propr repo toggle ${fullName} --auto-ci-followup`);
            console.log(`  propr repo toggle ${fullName} --no-auto-ci-followup`);
            console.log(`  propr repo toggle ${fullName} --no-notifications`);
            console.log(`  propr repo toggle ${fullName} --auto-resolve-conflicts <on|off|inherit>`);
            console.log(`  propr repo toggle ${fullName} --auto-assign <on|off> --auto-assign-to <login|none> --auto-assign-review <on|off>`);
            console.log(`  propr repo toggle ${fullName} --visual-previews --preview-types image,video`);
            process.exit(1);
          }

          if (!fullName.includes("/")) {
            console.error(
              "Error: Repository name must be in 'owner/repo' format."
            );
            console.log("");
            console.log("Example: propr repo toggle integry/gitfix --enable");
            process.exit(1);
          }

          const enabled = options.enable ? true : options.disable ? false : undefined;
          const autoResolveMergeConflicts = options.autoResolveConflicts === undefined
            ? undefined
            : parseAutoResolveConflicts(options.autoResolveConflicts);
          const autoAssign = parseAutoAssignFlags(options);
          const visualPreviewUpdate = options.visualPreviews !== undefined || options.previewTypes !== undefined || options.previewInstructions !== undefined || options.githubAttachmentPlan !== undefined
            ? {
                ...(options.githubAttachmentPlan !== undefined && { githubAttachmentPlan: parseAttachmentPlan(options.githubAttachmentPlan) }),
                ...(options.visualPreviews !== undefined && { enabled: options.visualPreviews }),
                ...(options.previewTypes !== undefined && { types: parseVisualPreviewTypes(options.previewTypes) }),
                ...(options.previewInstructions !== undefined && { instructions: options.previewInstructions.trim() })
              }
            : undefined;
          console.log(`Updating repository settings: ${fullName}...`);

          const result = await updateRepo(fullName, {
            ...(enabled !== undefined && { enabled }),
            ...(options.autoCiFollowup !== undefined && {
              autoFollowupOnFailedCi: options.autoCiFollowup,
            }),
            ...(options.notifications !== undefined && { notificationsEnabled: options.notifications }),
            ...(autoResolveMergeConflicts !== undefined && { autoResolveMergeConflicts }),
            ...(options.githubPrTemplate !== undefined && { githubPrTemplateFallback: options.githubPrTemplate }),
            ...autoAssign,
            ...(visualPreviewUpdate && { visualPreview: visualPreviewUpdate }),
          });

          if (result.success) {
            console.log("");
            console.log(`Successfully updated repository: ${fullName}`);
            if (enabled !== undefined) {
              console.log(`  Monitoring: ${formatEnabled(enabled)}`);
            }
            if (options.autoCiFollowup !== undefined) {
              console.log(
                `  Automatic CI follow-up: ${formatEnabled(options.autoCiFollowup)}`
              );
            }
            if (options.notifications !== undefined) {
              console.log(`  Notifications: ${formatEnabled(options.notifications)}`);
            }
            if (autoResolveMergeConflicts !== undefined) {
              console.log(`  Auto-resolve merge conflicts: ${formatAutoResolveConflicts(autoResolveMergeConflicts)}`);
            }
            if (options.githubPrTemplate !== undefined) {
              console.log(`  GitHub PR template fallback: ${formatEnabled(options.githubPrTemplate)}`);
            }
            if (autoAssign.autoAssignPullRequests !== undefined) {
              console.log(`  Auto-assign pull requests: ${autoAssign.autoAssignPullRequests ? "On" : "Off"}`);
            }
            if (autoAssign.autoAssignDefaultAssignee !== undefined) {
              console.log(`  Auto-assign to: ${autoAssign.autoAssignDefaultAssignee ? `@${autoAssign.autoAssignDefaultAssignee}` : "issue author"}`);
            }
            if (autoAssign.autoAssignRequestReview !== undefined) {
              console.log(`  Request review from assignee: ${autoAssign.autoAssignRequestReview ? "On" : "Off"}`);
            }
            if (visualPreviewUpdate) {
              const previewState = options.visualPreviews === false
                ? 'Disabled'
                : options.previewTypes ? parseVisualPreviewTypes(options.previewTypes).join('+') : 'Updated';
              console.log(`  Visual previews: ${previewState}`);
            }
          } else {
            console.error("Failed to update repository.");
            process.exit(1);
          }
        } catch (error) {
          const classification = classifyApiError(error);
          const errorMessage = classification.message;
          if (
            classification.kind === "unauthorized" ||
            classification.kind === "forbidden"
          ) {
            presentApiError(error, {
              forbiddenMessage: "Error: Access denied. You do not have permission to update repositories.",
              fallbackMessage: `Error updating repository: ${errorMessage}`,
            });
          } else if (
            (classification.status === undefined || classification.status === 404) &&
            errorMessage.includes("not being monitored")
          ) {
            console.error(`Error: Repository "${fullName}" is not being monitored.`);
            console.log("");
            console.log("Use 'propr repo list' to see currently monitored repositories.");
            console.log(
              "To add a new repository, use 'propr repo add <owner/repo>'."
            );
          } else {
            presentApiError(error, {
              forbiddenMessage: "Error: Access denied. You do not have permission to update repositories.",
              fallbackMessage: `Error updating repository: ${errorMessage}`,
            });
          }
          process.exit(1);
        }
      }
    );

  // repo index
  repo
    .command("index <fullName>")
    .description("Trigger codebase indexing for a repository")
    .option("-b, --branch <branch>", "Specify the base branch to index")
    .option("--incremental", "Perform incremental indexing instead of full reindex")
    .addHelpText("after", `
Argument:
  fullName    Repository in owner/repo format

Indexing Modes:
  Full (default)    Re-index the entire repository
  Incremental       Only index changes since last index

Examples:
  $ propr repo index myorg/myrepo                    # Full reindex
  $ propr repo index myorg/myrepo --incremental     # Incremental index
  $ propr repo index myorg/myrepo -b develop        # Index specific branch
`)
    .action(
      async (
        fullName: string,
        options: { branch?: string; incremental?: boolean }
      ) => {
        try {
          if (!fullName.includes("/")) {
            console.error(
              "Error: Repository name must be in 'owner/repo' format."
            );
            console.log("");
            console.log("Example: propr repo index integry/gitfix");
            process.exit(1);
          }

          const parts = fullName.split("/");
          if (parts.length !== 2 || !parts[0] || !parts[1]) {
            console.error(
              "Error: Invalid repository format. Expected 'owner/repo'."
            );
            process.exit(1);
          }

          const indexType = options.incremental ? "incremental" : "full";
          console.log(`Triggering ${indexType} indexing for repository: ${fullName}...`);

          const result = await triggerIndexing(fullName, {
            fullReindex: !options.incremental,
            baseBranch: options.branch,
          });

          if (result.success) {
            console.log("");
            console.log(`Successfully triggered indexing for repository: ${fullName}`);
            if (result.jobId) {
              console.log(`  Job ID: ${result.jobId}`);
            }
            if (result.correlationId) {
              console.log(`  Correlation ID: ${result.correlationId}`);
            }
            if (options.branch) {
              console.log(`  Branch: ${options.branch}`);
            }
            console.log(`  Mode: ${indexType} reindex`);
            console.log("");
            console.log("Use 'propr repo status <fullName>' to check indexing progress.");
          } else {
            console.error(`Failed to trigger indexing: ${result.error || "Unknown error"}`);
            process.exit(1);
          }
        } catch (error) {
          const classification = classifyApiError(error);
          const errorMessage = classification.message;
          if (
            classification.kind === "unauthorized" ||
            classification.kind === "forbidden"
          ) {
            presentApiError(error, {
              forbiddenMessage: "Error: Access denied. You do not have permission to trigger indexing.",
              fallbackMessage: `Error triggering indexing: ${errorMessage}`,
            });
          } else if (
            (classification.status === undefined || classification.status === 409) &&
            errorMessage.includes("already queued")
          ) {
            console.error(`Error: Indexing for "${fullName}" is already in progress or queued.`);
            console.log("");
            console.log("Use 'propr repo status' to check the current indexing status.");
          } else {
            presentApiError(error, {
              forbiddenMessage: "Error: Access denied. You do not have permission to trigger indexing.",
              fallbackMessage: `Error triggering indexing: ${errorMessage}`,
            });
          }
          process.exit(1);
        }
      }
    );

  // repo status
  repo
    .command("status [fullName]")
    .description("View indexing status and progress for repositories")
    .option("-j, --json", "Output as JSON for programmatic use")
    .addHelpText("after", `
Argument:
  fullName    (Optional) Repository in owner/repo format

Examples:
  $ propr repo status                    # Show all repositories
  $ propr repo status myorg/myrepo       # Show specific repository
  $ propr repo status --json             # JSON output
`)
    .action(async (fullName: string | undefined, options: { json?: boolean }) => {
      try {
        const result = await getIndexingStatus(fullName);

        if (printOutput(result, options.json ?? false)) {
          return;
        }

        console.log("Fetching indexing status...");

        if (result.repositories.length === 0) {
          console.log("");
          if (fullName) {
            console.log(`No indexing status found for repository: ${fullName}`);
            console.log("");
            console.log("Make sure the repository is being monitored:");
            console.log("  propr repo list");
          } else {
            console.log("No repositories are currently being tracked for indexing.");
            console.log("");
            console.log("To add a repository, use:");
            console.log("  propr repo add <owner/repo>");
          }
          return;
        }

        console.log("");
        displayIndexingStatusTable(result.repositories);

        console.log("");
        console.log(`Total: ${result.repositories.length} repository(ies)`);
      } catch (error) {
        presentApiError(error, {
          forbiddenMessage: "Error: Access denied. You do not have permission to view indexing status.",
          fallbackMessage: (message) => `Error fetching indexing status: ${message}`,
        });
        process.exit(1);
      }
    });

  return repo;
}
