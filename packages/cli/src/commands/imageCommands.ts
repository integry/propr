/**
 * Docker image maintenance commands for the local ProPR stack.
 */

import { Command } from "commander";
import { createConfigManager } from "../config/index.js";
import { getHostConfig } from "../orchestrator/index.js";

interface PullOptions {
  root?: string;
  skipRemoteImageCheck?: boolean;
}

async function pullImages(options: PullOptions): Promise<void> {
  const configManager = await createConfigManager();
  const { orch, cfg, rootDir } = await getHostConfig({ configManager, root: options.root });

  if (!orch.dockerAvailable()) {
    console.error("Error: cannot reach the Docker daemon. Run 'propr check' for diagnostics.");
    process.exit(1);
  }

  console.log(`Pulling ProPR images (root: ${rootDir})`);
  const env = options.skipRemoteImageCheck
    ? { ...process.env, PROPR_SKIP_REMOTE_IMAGE_CHECK: "1" }
    : process.env;
  const { failedAgentImages, strictAgentPull } = orch.pullImages(cfg, {
    env,
    onLog: (line) => console.log(line),
  });

  if (failedAgentImages.length > 0) {
    console.warn(`\nwarning: ${failedAgentImages.length} agent image(s) could not be pulled:`);
    for (const tag of failedAgentImages) console.warn(`    - ${tag}`);
    console.warn("  Jobs using those agents will fail until the images are available.");
    if (strictAgentPull) process.exit(1);
  }
}

export function createImagesCommand(): Command {
  const images = new Command("images")
    .description("Manage local ProPR Docker images");

  images
    .command("pull")
    .description("Pull missing or stale ProPR Docker images without starting the stack")
    .option("--root <dir>", "Stack root directory (where .env/data/logs/repos live)")
    .option("--skip-remote-image-check", "Skip registry freshness checks before deciding what to pull")
    .addHelpText("after", `
Examples:
  $ propr images pull
  $ propr images pull --skip-remote-image-check
  $ propr images pull --root ~/propr
`)
    .action(async (options: PullOptions) => {
      try {
        await pullImages(options);
      } catch (error) {
        console.error(`Error pulling images: ${(error as Error).message}`);
        process.exit(1);
      }
    });

  return images;
}
