/**
 * Local repository initialization command.
 *
 * Scaffolds the .propr directory used by ProPR agent execution containers.
 */

import { Command } from "commander";
import path from "path";
import { chmod, mkdir, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { printOutput } from "../utils/io.js";

interface ScaffoldFile {
  relativePath: string;
  content: string;
  mode?: number;
}

export interface InitCommandOptions {
  cwd?: string;
  force?: boolean;
}

export interface InitCommandResult {
  directory: string;
  created: string[];
  skipped: string[];
  overwritten: string[];
}

const SETUP_SH = `#!/usr/bin/env bash
set -euo pipefail

# This hook runs before each ProPR implementation execution.
# Available environment variables:
#   PROPR_WORKSPACE   Mounted repository path inside the agent container
#   PROPR_CACHE_DIR   Writable cache directory outside the repository
#   PROPR_AGENT_TYPE  claude, codex, gemini, or opencode

cd "$PROPR_WORKSPACE"

if [ -f ".propr/package.json" ]; then
  export npm_config_cache="$PROPR_CACHE_DIR/npm"
  mkdir -p "$npm_config_cache"

  cd ".propr"
  if [ -f "package-lock.json" ]; then
    npm ci
  else
    npm install
  fi
fi

# Example for Alpine-based agent images:
# sudo apk add --no-cache jq
`;

const PACKAGE_JSON = `{
  "name": "propr-repo-tools",
  "private": true,
  "version": "0.0.0",
  "description": "Repository-local tools installed before ProPR agent executions",
  "dependencies": {}
}
`;

const GITIGNORE = `node_modules/
cache/
.cache/
`;

const README = `# ProPR Repository Setup

This directory configures repository-local setup for ProPR agent executions.

Before each implementation execution, ProPR runs:

\`\`\`bash
.propr/setup.sh
\`\`\`

Use \`.propr/package.json\` for npm packages that agents need while working in this repository.
Use \`sudo apk add --no-cache <package>\` in \`setup.sh\` for Alpine system packages.

Runtime caches and installed packages should stay out of commits.
`;

const SCAFFOLD_FILES: ScaffoldFile[] = [
  { relativePath: "setup.sh", content: SETUP_SH, mode: 0o755 },
  { relativePath: "package.json", content: PACKAGE_JSON },
  { relativePath: ".gitignore", content: GITIGNORE },
  { relativePath: "README.md", content: README },
];

export async function scaffoldProprDirectory(
  options: InitCommandOptions = {}
): Promise<InitCommandResult> {
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const proprDir = path.join(cwd, ".propr");
  const result: InitCommandResult = {
    directory: proprDir,
    created: [],
    skipped: [],
    overwritten: [],
  };

  await mkdir(proprDir, { recursive: true });

  for (const file of SCAFFOLD_FILES) {
    const filePath = path.join(proprDir, file.relativePath);
    const exists = existsSync(filePath);

    if (exists && !options.force) {
      result.skipped.push(file.relativePath);
      continue;
    }

    await writeFile(filePath, file.content, "utf-8");
    if (file.mode !== undefined) {
      await chmod(filePath, file.mode);
    }

    if (exists) {
      result.overwritten.push(file.relativePath);
    } else {
      result.created.push(file.relativePath);
    }
  }

  return result;
}

function displayInitResult(result: InitCommandResult): void {
  console.log(`Initialized ProPR repository setup at: ${result.directory}`);

  if (result.created.length > 0) {
    console.log(`Created: ${result.created.join(", ")}`);
  }
  if (result.overwritten.length > 0) {
    console.log(`Overwritten: ${result.overwritten.join(", ")}`);
  }
  if (result.skipped.length > 0) {
    console.log(`Skipped existing files: ${result.skipped.join(", ")}`);
    console.log("Use --force to overwrite existing scaffold files.");
  }

  console.log("");
  console.log("Add npm packages with:");
  console.log("  cd .propr && npm install <package>");
  console.log("");
  console.log("Add system packages by editing .propr/setup.sh:");
  console.log("  sudo apk add --no-cache <package>");
}

export function createInitCommand(): Command {
  const command = new Command("init");

  command
    .description("Scaffold .propr repository setup files in the current directory")
    .option("-f, --force", "Overwrite existing scaffold files")
    .option("-j, --json", "Output result as JSON")
    .addHelpText("after", `
Examples:
  $ propr init
  $ propr init --force
  $ propr init --json
`)
    .action(async (options: { force?: boolean; json?: boolean }) => {
      try {
        const result = await scaffoldProprDirectory({ force: options.force });
        if (printOutput(result, !!options.json)) {
          return;
        }
        displayInitResult(result);
      } catch (error) {
        console.error(`Error initializing .propr directory: ${(error as Error).message}`);
        process.exit(1);
      }
    });

  return command;
}
