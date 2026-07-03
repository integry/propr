import { Command } from "commander";
import { createConfigManager } from "../config/index.js";
import type { RemoteProfile } from "../config/index.js";
import { printOutput } from "../utils/index.js";

function redactToken(token: string | undefined): string {
  if (!token) return "(not set)";
  if (token.length <= 8) return "(set)";
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

export function createConfigCommand(): Command {
  const config = new Command("config")
    .description("Inspect and manage CLI configuration and remote profiles");

  config
    .command("list")
    .description("List CLI configuration and named remote profiles")
    .option("-j, --json", "Output as JSON")
    .action(async (options: { json?: boolean }) => {
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
    });

  config
    .command("get [key]")
    .description("Get CLI configuration or a single key from the active profile")
    .option("-j, --json", "Output as JSON")
    .action(async (key: string | undefined, options: { json?: boolean }) => {
      const manager = await createConfigManager();
      const activeProfile = manager.getActiveRemoteProfile();
      const profile = manager.getRemoteProfiles()[activeProfile] ?? {};
      const view = {
        activeProfile,
        remoteUrl: profile.remoteUrl,
        defaultProject: profile.defaultProject,
        githubToken: redactToken(profile.githubToken),
      };

      if (key) {
        if (!(key in view)) {
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
      console.log(`Active profile: ${view.activeProfile}`);
      console.log(`Remote URL:     ${view.remoteUrl ?? "(not set)"}`);
      console.log(`Default project:${view.defaultProject ? ` ${view.defaultProject}` : " (not set)"}`);
      console.log(`GitHub token:   ${view.githubToken}`);
    });

  const profile = config
    .command("profile")
    .description("Manage named remote profiles");

  profile
    .command("use <name>")
    .description("Switch the active remote profile, creating it if needed")
    .action(async (name: string) => {
      const manager = await createConfigManager();
      await manager.useRemoteProfile(name);
      console.log(`Active profile set to: ${manager.getActiveRemoteProfile()}`);
      console.log(`Configuration saved to: ${manager.getConfigFilePath()}`);
    });

  profile
    .command("set <name>")
    .description("Create or update a named remote profile")
    .option("--remote <url>", "Backend API URL")
    .option("--token <token>", "GitHub token")
    .option("--project <project>", "Default project (owner/repo)")
    .action(async (name: string, options: { remote?: string; token?: string; project?: string }) => {
      const manager = await createConfigManager();
      const previous = manager.getActiveRemoteProfile();
      await manager.useRemoteProfile(name);
      if (options.remote) await manager.setRemoteUrl(options.remote);
      if (options.token) await manager.setGithubToken(options.token);
      if (options.project) await manager.setDefaultProject(options.project);
      if (previous !== name) await manager.useRemoteProfile(previous);
      console.log(`Profile saved: ${name}`);
      console.log(`Configuration saved to: ${manager.getConfigFilePath()}`);
    });

  return config;
}
