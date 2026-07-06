import { Command } from "commander";
import { createConfigManager } from "../config/index.js";
import type { RemoteProfile } from "../config/index.js";
import { normalizeProjectSlug, printOutput } from "../utils/index.js";

function redactToken(token: string | undefined): string {
  if (!token) return "(not set)";
  // Below this length the 4+4 preview would expose most of the token.
  if (token.length <= 12) return "(set)";
  return `${token.slice(0, 4)}...${token.slice(-4)}`;
}

type SanitizedRemoteProfile = Omit<RemoteProfile, "githubToken"> & {
  githubToken: string;
};

export function sanitizeRemoteProfile(profile: RemoteProfile): SanitizedRemoteProfile {
  return {
    remoteUrl: profile.remoteUrl,
    defaultProject: profile.defaultProject,
    githubToken: redactToken(profile.githubToken),
  };
}

export function sanitizeRemoteProfiles(
  profiles: Record<string, RemoteProfile>
): Record<string, SanitizedRemoteProfile> {
  return Object.fromEntries(
    Object.entries(profiles).map(([name, profile]) => [name, sanitizeRemoteProfile(profile)])
  );
}

export function isValidRemoteUrl(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed !== value || trimmed.length === 0) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function createConfigCommand(): Command {
  const config = new Command("config")
    .description("Inspect and manage CLI configuration and remote profiles");

  config
    .command("list")
    .description("List CLI configuration and named remote profiles")
    .option("-j, --json", "Output as JSON")
    .addHelpText("after", `
Note:
  GitHub token values are always redacted, including in --json output.
  The CLI never prints stored secrets.
`)
    .action(async (options: { json?: boolean }) => {
      try {
        const manager = await createConfigManager();
        const profiles = manager.getRemoteProfiles();
        const sanitizedProfiles = sanitizeRemoteProfiles(profiles);
        if (printOutput({ activeProfile: manager.getActiveRemoteProfile(), profiles: sanitizedProfiles, configFile: manager.getConfigFilePath() }, options.json ?? false)) {
          return;
        }

        console.log(`Config file: ${manager.getConfigFilePath()}`);
        console.log(`Active profile: ${manager.getActiveRemoteProfile()}`);
        console.log("");
        console.log("Profiles:");
        for (const [name, profile] of Object.entries(profiles)) {
          const activeMarker = name === manager.getActiveRemoteProfile() ? "*" : " ";
          console.log(`${activeMarker} ${name}`);
          console.log(`    Remote:  ${profile.remoteUrl ?? "(not set)"}`);
          console.log(`    Project: ${profile.defaultProject ?? "(not set)"}`);
          console.log(`    Token:   ${redactToken(profile.githubToken)}`);
        }
      } catch (error) {
        console.error(`Error listing configuration: ${(error as Error).message}`);
        process.exit(1);
      }
    });

  config
    .command("get [key]")
    .description("Get CLI configuration or a single key from the active profile")
    .option("-j, --json", "Output as JSON")
    .addHelpText("after", `
Keys:
  activeProfile, remoteUrl, defaultProject, githubToken

Note:
  The githubToken value is always redacted, including in --json output.
  The CLI never prints stored secrets.
`)
    .action(async (key: string | undefined, options: { json?: boolean }) => {
      try {
        const manager = await createConfigManager();
        const activeProfile = manager.getActiveRemoteProfile();
        const view = {
          activeProfile,
          remoteUrl: manager.getRemoteUrl(),
          defaultProject: manager.getDefaultProject(),
          githubToken: redactToken(manager.getGithubToken()),
        };

        if (key) {
          if (!Object.prototype.hasOwnProperty.call(view, key)) {
            console.error(`Error: Unknown config key: ${key}`);
            process.exit(1);
          }
          const value = view[key as keyof typeof view];
          if (options.json) {
            printOutput({ [key]: value }, true);
          } else {
            console.log(value ?? "(not set)");
          }
          return;
        }

        if (printOutput(view, options.json ?? false)) {
          return;
        }
        console.log(`Active profile:  ${view.activeProfile}`);
        console.log(`Remote URL:      ${view.remoteUrl ?? "(not set)"}`);
        console.log(`Default project: ${view.defaultProject ?? "(not set)"}`);
        console.log(`GitHub token:    ${view.githubToken}`);
      } catch (error) {
        console.error(`Error reading configuration: ${(error as Error).message}`);
        process.exit(1);
      }
    });

  const profile = config
    .command("profile")
    .description("Manage named remote profiles");

  profile
    .command("use <name>")
    .description("Switch the active remote profile, creating it if needed")
    .action(async (name: string) => {
      try {
        const manager = await createConfigManager();
        const { created } = await manager.useRemoteProfile(name);
        if (created) {
          console.warn(
            `Warning: Profile "${manager.getActiveRemoteProfile()}" did not exist and was created empty. ` +
            `Configure it with 'propr config profile set ${manager.getActiveRemoteProfile()} --remote <url>'.`
          );
        }
        console.log(`Active profile set to: ${manager.getActiveRemoteProfile()}`);
        console.log(`Configuration saved to: ${manager.getConfigFilePath()}`);
      } catch (error) {
        console.error(`Error switching profile: ${(error as Error).message}`);
        process.exit(1);
      }
    });

  profile
    .command("set <name>")
    .description("Create or update a named remote profile")
    .option("--remote <url>", "Backend API URL")
    .option("--token <token>", "GitHub token")
    .option("--project <project>", "Default project (owner/repo)")
    .option("--clear-remote", "Clear the backend API URL")
    .option("--clear-token", "Clear the GitHub token")
    .option("--clear-project", "Clear the default project")
    .addHelpText("after", `
Note:
  --token places the secret in shell history and process listings.
  Prefer 'propr login' on the target profile to store a token.
`)
    .action(async (name: string, options: {
      remote?: string;
      token?: string;
      project?: string;
      clearRemote?: boolean;
      clearToken?: boolean;
      clearProject?: boolean;
    }) => {
      try {
        const conflicts: string[] = [];
        if (options.remote !== undefined && options.clearRemote) conflicts.push("--remote with --clear-remote");
        if (options.token !== undefined && options.clearToken) conflicts.push("--token with --clear-token");
        if (options.project !== undefined && options.clearProject) conflicts.push("--project with --clear-project");
        if (conflicts.length > 0) {
          console.error(`Error: Conflicting options: ${conflicts.join(", ")}. Provide either the value or its --clear-* flag, not both.`);
          process.exit(1);
        }
        const manager = await createConfigManager();
        const clear: Array<keyof RemoteProfile> = [];
        if (options.clearRemote) clear.push("remoteUrl");
        if (options.clearToken) clear.push("githubToken");
        if (options.clearProject) clear.push("defaultProject");
        const project = options.project !== undefined ? normalizeProjectSlug(options.project) : undefined;
        if (options.project !== undefined && project === null) {
          console.error("Error: Invalid project format. Expected 'owner/repo'.");
          process.exit(1);
        }
        if (options.remote !== undefined && !isValidRemoteUrl(options.remote)) {
          console.error("Error: Invalid remote URL. Expected an http:// or https:// URL.");
          process.exit(1);
        }
        const patch = {
          ...(options.remote !== undefined ? { remoteUrl: options.remote } : {}),
          ...(options.token !== undefined ? { githubToken: options.token } : {}),
          ...(project != null ? { defaultProject: project } : {}),
        };
        if (Object.keys(patch).length === 0 && clear.length === 0) {
          console.warn("No profile changes specified.");
          return;
        }
        await manager.setRemoteProfile(
          name,
          patch,
          clear
        );
        console.log(`Profile saved: ${name}`);
        console.log(`Configuration saved to: ${manager.getConfigFilePath()}`);
      } catch (error) {
        console.error(`Error saving profile: ${(error as Error).message}`);
        process.exit(1);
      }
    });

  return config;
}
