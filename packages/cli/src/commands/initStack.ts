/**
 * `propr init stack`
 *
 * Scaffolds a local control-plane stack root: copies .env from .env.example,
 * creates data/, logs/ and repos/, detects host agent-credential directories and
 * records them as HOST_*_DIR, and saves the stack root to the CLI config so the
 * other control-plane commands can find it.
 */

import { Command } from "commander";
import { existsSync, copyFileSync, chmodSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { createConfigManager } from "../config/index.js";

interface DetectedCred {
  envKey: string;
  path: string;
}

/** Resolve the bundled .env.example, falling back to a repo checkout. */
function resolveEnvExample(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  // Bundled copy is renamed to avoid npm's .env* exclusion from tarballs.
  const bundled = join(here, "..", "assets", "env.example.txt");
  if (existsSync(bundled)) return bundled;
  const bundledLegacy = join(here, "..", "assets", ".env.example");
  if (existsSync(bundledLegacy)) return bundledLegacy;

  let dir = here;
  for (let i = 0; i < 8; i += 1) {
    const candidate = join(dir, ".env.example");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/** Detect host agent-credential directories that exist on this machine. */
function detectCredentials(): DetectedCred[] {
  const home = homedir();
  const candidates: DetectedCred[] = [
    { envKey: "HOST_CLAUDE_DIR", path: join(home, ".claude") },
    { envKey: "HOST_CODEX_DIR", path: join(home, ".codex") },
    { envKey: "HOST_ANTIGRAVITY_DIR", path: join(home, ".gemini") },
    { envKey: "HOST_OPENCODE_XDG_DIR", path: join(home, ".config", "opencode") },
    { envKey: "HOST_OPENCODE_DATA_DIR", path: join(home, ".local", "share", "opencode") },
    { envKey: "HOST_VIBE_DIR", path: join(home, ".vibe") },
  ];
  // Only keep dirs that exist and are safe as Docker bind mounts (no ':').
  return candidates.filter((c) => existsSync(c.path) && !c.path.includes(":"));
}

export interface InitStackOptions {
  root?: string;
  force?: boolean;
}

export interface InitStackResult {
  rootDir: string;
  envCreated: boolean;
  envSkipped: boolean;
  envBackedUp: boolean;
  dirsCreated: string[];
  detected: DetectedCred[];
}

export async function scaffoldStack(options: InitStackOptions = {}): Promise<InitStackResult> {
  const rootDir = resolve(options.root ?? process.cwd());
  const envPath = join(rootDir, ".env");
  const result: InitStackResult = {
    rootDir,
    envCreated: false,
    envSkipped: false,
    envBackedUp: false,
    dirsCreated: [],
    detected: [],
  };

  mkdirSync(rootDir, { recursive: true });

  // 1. data/logs/repos directories
  for (const sub of ["data", "logs", "repos"]) {
    const dir = join(rootDir, sub);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      result.dirsCreated.push(sub);
    }
  }

  // 2. .env from .env.example
  if (existsSync(envPath) && !options.force) {
    result.envSkipped = true;
  } else {
    const example = resolveEnvExample();
    if (!example) {
      throw new Error(
        "Could not locate .env.example. Run `npm run build` in packages/cli, or run from a ProPR source checkout."
      );
    }
    if (options.force && existsSync(envPath)) {
      const bakPath = `${envPath}.bak`;
      copyFileSync(envPath, bakPath);
      try { chmodSync(bakPath, 0o600); } catch { /* best-effort */ }
      result.envBackedUp = true;
    }
    copyFileSync(example, envPath);
    try {
      chmodSync(envPath, 0o600);
    } catch {
      // Best-effort — may fail on Windows or non-owned files.
    }
    result.envCreated = true;
  }

  // 3. Detect credential dirs and record any not already present in .env
  const detected = detectCredentials();
  const envContent = readFileSync(envPath, "utf-8");
  const toAppend = detected.filter((c) => {
    // already set (uncommented) in the env file?
    const re = new RegExp(`^\\s*(export\\s+)?${c.envKey}\\s*=`, "m");
    return !re.test(envContent);
  });
  if (toAppend.length > 0) {
    const block =
      "\n# --- Host agent-credential directories (detected by `propr init stack`) ---\n" +
      toAppend.map((c) => `${c.envKey}=${c.path}`).join("\n") +
      "\n";
    appendFileSync(envPath, block, "utf-8");
  }
  result.detected = detected;

  // 4. Persist the stack root so other commands can find it.
  const configManager = await createConfigManager();
  await configManager.setStackRoot(rootDir);

  return result;
}

function displayResult(result: InitStackResult): void {
  console.log(`Initialized ProPR stack at: ${result.rootDir}`);
  if (result.dirsCreated.length > 0) {
    console.log(`Created directories: ${result.dirsCreated.join(", ")}`);
  }
  if (result.envCreated && result.envBackedUp) {
    console.log("Overwrote .env from .env.example (previous saved to .env.bak)");
  } else if (result.envCreated) {
    console.log("Created .env from .env.example");
  } else if (result.envSkipped) {
    console.log("Kept existing .env (use --force to overwrite)");
  }
  if (result.detected.length > 0) {
    console.log("");
    console.log("Detected agent credentials on this host:");
    for (const c of result.detected) {
      console.log(`  ${c.envKey}=${c.path}`);
    }
  } else {
    console.log("");
    console.log("No agent credential directories detected (~/.claude, ~/.codex, ~/.gemini, ~/.config/opencode, ~/.vibe).");
    console.log("Log in with an agent CLI on this host, then re-run `propr init stack`.");
  }
  console.log("");
  console.log("Next steps:");
  console.log("  1. Review and edit .env (GitHub credentials, ports, etc.)");
  console.log("  2. propr check          # verify the environment");
  console.log("  3. propr start          # launch the stack");
}

/** Creates the `init stack` subcommand. */
export function createInitStackCommand(): Command {
  return new Command("stack")
    .description("Scaffold a local stack root (.env, data/, logs/, repos/) and detect agent credentials")
    .option("--root <dir>", "Stack root directory (default: current directory)")
    .option("-f, --force", "Overwrite an existing .env")
    .option("-j, --json", "Output result as JSON")
    .addHelpText("after", `
Examples:
  $ propr init stack
  $ propr init stack --root ~/propr
  $ propr init stack --force
`)
    .action(async (options: { root?: string; force?: boolean; json?: boolean }) => {
      try {
        const result = await scaffoldStack({ root: options.root, force: options.force });
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        displayResult(result);
      } catch (error) {
        console.error(`Error initializing stack: ${(error as Error).message}`);
        process.exit(1);
      }
    });
}
