/**
 * `propr setup` — guided one-time setup for the local ProPR stack.
 *
 * The flow itself lives in the UI-agnostic engine (./setup/engine.ts). This
 * command only chooses how to render it:
 *
 *   • The full-screen Ink wizard (../tui/app.tsx) when stdin and stdout are
 *     interactive TTYs that support raw mode — the keyboard-driven view.
 *   • The sequential readline wizard (./setup/sequential.ts) otherwise: an
 *     explicit `--no-tui`, or an interactive terminal that can't enter raw mode
 *     (some SSH sessions, minimal/embedded terminals). It prompts line by line.
 *
 * These two are distinct from the no-stdin case. When stdin is not a TTY at all
 * (piped, redirected, CI), nobody can answer a prompt, so the sequential wizard
 * fails fast with actionable guidance rather than hanging — see
 * {@link runSequentialSetup}.
 */

import { Command } from "commander";
import { createInterface } from "node:readline/promises";
import { createConfigManager } from "../config/index.js";
import type { ConfigManager } from "../config/index.js";
import { runSequentialSetup, SequentialSetupUnavailableError } from "./setup/sequential.js";

export interface SetupCommandOptions {
  root?: string;
  /** Commander sets this to false for `--no-tui`. */
  tui?: boolean;
  /** Commander sets this for `--skip-remote-image-check`. */
  skipRemoteImageCheck?: boolean;
}

/**
 * Whether the full-screen Ink wizard can run. It needs interactive input *and*
 * output plus raw-mode support for its keyboard handling; anything short of
 * that drops to the sequential readline wizard. Kept as a pure function of the
 * streams so the decision is unit-testable without a real terminal.
 */
export function canRenderInkSetup(
  stdin: { isTTY?: boolean; setRawMode?: unknown } = process.stdin,
  stdout: { isTTY?: boolean } = process.stdout
): boolean {
  return Boolean(stdin.isTTY) && Boolean(stdout.isTTY) && typeof stdin.setRawMode === "function";
}

/**
 * Authenticate before Ink enables terminal raw mode. Reuse an existing `gh`
 * session silently; otherwise ask one default-Yes question and let `gh auth
 * login` own the terminal. Both Connect enrollment and the protected local API
 * steps used by a custom-App setup then have the user token they require.
 */
async function prepareInkGithubLogin(configManager: ConfigManager, root?: string): Promise<void> {
  const { detectGithubAuthMode, resolveSetupRoot } = await import("./setup/state.js");
  const currentAuth = detectGithubAuthMode(resolveSetupRoot(configManager, root));
  if (currentAuth.mode === "demo") return;
  if (configManager.getGithubToken()) return;
  const { loginWithGithubCli } = await import("../auth/githubLogin.js");
  const reused = await loginWithGithubCli(configManager, { interactive: false });
  if (reused.ok) return;

  const readline = createInterface({ input: process.stdin, output: process.stdout });
  let answer = "";
  try {
    answer = await readline.question("Log in to GitHub to finish protected setup steps? [Y/n] ");
  } finally {
    readline.close();
  }
  if (/^n(?:o)?$/i.test(answer.trim())) return;

  const result = await loginWithGithubCli(configManager, {
    interactive: true,
    onLog: (line) => console.log(line),
  });
  if (!result.ok) console.warn(`GitHub login was not completed: ${result.message}`);
}

export function createSetupCommand(): Command {
  return new Command("setup")
    .description("Guided one-time setup for the local ProPR stack")
    .option("--root <dir>", "Stack root directory (where .env/data/logs/repos live)")
    .option("--no-tui", "Skip the full-screen wizard; prompt line-by-line instead")
    .option(
      "--skip-remote-image-check",
      "Skip the slow registry round-trip when checking that stack images exist"
    )
    .addHelpText("after", `
Examples:
  $ propr setup
  $ propr setup --no-tui
  $ propr setup --root ~/propr
  $ propr setup --skip-remote-image-check

Setup is safe to re-run at any time: it re-discovers your environment and skips
steps that are already satisfied, so running it again only fills in what is
missing — it never undoes existing configuration.

The full-screen wizard runs in an interactive terminal. Over SSH, in shells
without raw-mode support, or with --no-tui, setup falls back to line-by-line
prompts. When stdin is not a terminal at all (piped, redirected, CI), setup
cannot prompt and exits with guidance — scaffold non-interactively instead with
\`propr init stack\`, then edit <root>/.env and run \`propr start\`.
`)
    .action(async (options: SetupCommandOptions) => {
      try {
        const configManager = await createConfigManager();
        const { skipRemoteImageCheck } = options;
        const useInk = options.tui !== false && canRenderInkSetup();

        if (useInk) {
          await prepareInkGithubLogin(configManager, options.root);
          // Loaded dynamically so the sequential path never pulls in ink/react.
          const { renderSetupWizard } = await import("../tui/app.js");
          const result = await renderSetupWizard({
            configManager,
            root: options.root,
            skipRemoteImageCheck,
          });
          process.exit(result.completed ? 0 : 1);
        }

        const result = await runSequentialSetup({
          configManager,
          root: options.root,
          skipRemoteImageCheck,
        });
        process.exit(result.completed ? 0 : 1);
      } catch (error) {
        if (error instanceof SequentialSetupUnavailableError) {
          // Already actionable guidance — print it verbatim, no "Error:" prefix.
          console.error(error.message);
          process.exit(1);
        }
        console.error(`Error during setup: ${(error as Error).message}`);
        process.exit(1);
      }
    });
}
