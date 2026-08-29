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

import { Command, InvalidArgumentError, Option } from "commander";
import { createInterface } from "node:readline/promises";
import { createConfigManager } from "../config/index.js";
import type { ConfigManager } from "../config/index.js";
import { runSequentialSetup, SequentialSetupUnavailableError } from "./setup/sequential.js";
import {
  detectConfiguredAgentSkillTargets,
  installAgentSkill,
  parseAgentSkillTargets,
  resolveAgentSkillLocations,
  type AgentSkillEnvironment,
  type AgentSkillOperationResult,
  type AgentSkillTarget,
} from "../agentSkill.js";
import { formatAgentSkillOperation } from "./agentSkillCommands.js";

export interface SetupCommandOptions {
  root?: string;
  /** Commander sets this to false for `--no-tui`. */
  tui?: boolean;
  /** Commander sets this for `--skip-remote-image-check`. */
  skipRemoteImageCheck?: boolean;
  /** Comma-separated explicit targets for non-interactive-safe installation. */
  installSkill?: string;
  /** Commander sets this to false for `--no-skill`. */
  skill?: boolean;
}

export interface SetupSkillOfferOptions {
  explicitTargets?: string;
  enabled?: boolean;
  interactive?: boolean;
  env?: AgentSkillEnvironment;
  ask?: (question: string) => Promise<string>;
  log?: (line: string) => void;
  install?: (target: AgentSkillTarget) => AgentSkillOperationResult;
}

export interface SetupCommandDependencies {
  offerAgentSkill?: typeof offerSetupAgentSkill;
  createConfig?: typeof createConfigManager;
  runSequential?: typeof runSequentialSetup;
  exit?: (code: number) => void;
}

/**
 * Offer the bundled operator skill once during guided setup. A non-interactive
 * invocation performs no home-directory writes unless explicit targets were
 * supplied. Every target is independent: failures are reported with an
 * actionable recovery path and never become a stack-setup failure.
 */
export async function offerSetupAgentSkill(options: SetupSkillOfferOptions = {}): Promise<AgentSkillOperationResult[]> {
  const env = options.env ?? process.env;
  const log = options.log ?? ((line: string) => console.log(line));
  const explicit = options.explicitTargets?.trim();
  if (!explicit && (options.enabled === false || !options.interactive)) return [];

  let targets: AgentSkillTarget[];
  if (explicit) {
    // An explicit operator request is authoritative. Invalid targets must fail
    // setup instead of being downgraded to a non-fatal interactive skip.
    targets = parseAgentSkillTargets([explicit]);
  } else {
    try {
      const detected = detectConfiguredAgentSkillTargets(env);
      if (detected.length === 0) return [];
      log("");
      log("Install the ProPR Operator Agent Skill for detected tools?");
      for (const location of detected) log(`  ${location.target}: ${location.path}`);
      const answer = (await options.ask?.("Install these skills? [Y/n] ")) ?? "";
      if (/^n(?:o)?$/i.test(answer.trim())) return [];
      targets = detected.map(({ target }) => target);
    } catch (error) {
      log(`Agent Skill setup skipped: ${(error as Error).message}`);
      return [];
    }
  }

  const results: AgentSkillOperationResult[] = [];
  for (const target of targets) {
    try {
      const result = options.install?.(target) ?? installAgentSkill(target, { env });
      results.push(result);
      log(formatAgentSkillOperation(result));
      if (result.action === "failed" || result.action === "refused") {
        if (result.state === "unsafe") {
          log(`  Unsafe target: ${result.detail ?? "unsafe target"}`);
          log(`  Recovery: correct the unsafe target condition, then run: propr skill install ${target}`);
        } else {
          const force = result.state === "foreign" || result.state === "modified-managed";
          log(`  Recovery: propr skill install ${target}${force ? " --force" : ""}`);
        }
      }
    } catch (error) {
      const path = (() => {
        try { return resolveAgentSkillLocations([target], env)[0].path; } catch { return target; }
      })();
      log(`${target}: agent skill installation failed at ${path}: ${(error as Error).message}`);
      log(`  Recovery: propr skill install ${target}`);
    }
  }
  return results;
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

/** Deployment-wide demo mode is the only setup mode with unauthenticated APIs. */
export function shouldPrepareInkGithubLogin(
  proprDemoMode: string | undefined,
  hasGithubToken: boolean
): boolean {
  const normalizedDemoMode = proprDemoMode?.trim().toLowerCase();
  const deploymentDemoEnabled = ["true", "1", "yes", "on"].includes(normalizedDemoMode ?? "");
  return !deploymentDemoEnabled && !hasGithubToken;
}

/**
 * Authenticate before Ink enables terminal raw mode. Reuse an existing `gh`
 * session silently; otherwise ask one default-Yes question and let `gh auth
 * login` own the terminal. Both Connect enrollment and the protected local API
 * steps used by custom-App and GitHub-only demo setups then have the user token
 * they require.
 */
async function prepareInkGithubLogin(configManager: ConfigManager, root?: string): Promise<void> {
  const { readEnvVars, resolveSetupRoot } = await import("./setup/state.js");
  const rootDir = resolveSetupRoot(configManager, root);
  if (
    !shouldPrepareInkGithubLogin(
      readEnvVars(rootDir).PROPR_DEMO_MODE,
      Boolean(configManager.getGithubToken())
    )
  ) {
    return;
  }
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

export function createSetupCommand(dependencies: SetupCommandDependencies = {}): Command {
  return new Command("setup")
    .description("Guided one-time setup for the local ProPR stack")
    .option("--root <dir>", "Stack root directory (where .env/data/logs/repos live)")
    .option("--no-tui", "Skip the full-screen wizard; prompt line-by-line instead")
    .addOption(
      new Option("--install-skill <targets>", "Install the ProPR Operator skill for comma-separated targets")
        .argParser((value) => {
          try {
            parseAgentSkillTargets([value]);
            return value;
          } catch (error) {
            throw new InvalidArgumentError((error as Error).message);
          }
        })
        .conflicts("skill")
    )
    .addOption(new Option("--no-skill", "Do not offer Agent Skill installation").conflicts("installSkill"))
    .option(
      "--skip-remote-image-check",
      "Skip the slow registry round-trip when checking that stack images exist"
    )
    .addHelpText("after", `
Examples:
  $ propr setup
  $ propr setup --no-tui
  $ propr setup --root ~/propr
  $ propr setup --install-skill codex,claude
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
        let skillReadline: ReturnType<typeof createInterface> | undefined;
        const canPromptForSkill = Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
        await (dependencies.offerAgentSkill ?? offerSetupAgentSkill)({
          explicitTargets: options.installSkill,
          enabled: options.skill,
          interactive: canPromptForSkill,
          ask: canPromptForSkill
            ? async (question) => {
                skillReadline ??= createInterface({ input: process.stdin, output: process.stdout });
                return skillReadline.question(question);
              }
            : undefined,
        });
        skillReadline?.close();

        const configManager = await (dependencies.createConfig ?? createConfigManager)();
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
          (dependencies.exit ?? process.exit)(result.completed ? 0 : 1);
          return;
        }

        const result = await (dependencies.runSequential ?? runSequentialSetup)({
          configManager,
          root: options.root,
          skipRemoteImageCheck,
        });
        (dependencies.exit ?? process.exit)(result.completed ? 0 : 1);
      } catch (error) {
        if (error instanceof SequentialSetupUnavailableError) {
          // Already actionable guidance — print it verbatim, no "Error:" prefix.
          console.error(error.message);
          (dependencies.exit ?? process.exit)(1);
          return;
        }
        console.error(`Error during setup: ${(error as Error).message}`);
        (dependencies.exit ?? process.exit)(1);
      }
    });
}
