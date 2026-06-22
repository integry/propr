/**
 * Sequential (readline) fallback wizard for `propr setup`.
 *
 * The setup engine (./engine.ts) is UI-agnostic: it drives the flow, emits
 * progress through a {@link SetupReporter}, and collects decisions through
 * optional {@link SetupPrompts} hooks. The Ink TUI (../../tui/SetupApp.tsx)
 * wires those seams to a full-screen React view; this module wires the exact
 * same seams to plain `readline/promises` prompts and line-by-line output.
 *
 * It exists for every terminal where Ink can't run — no raw-mode support, SSH
 * shells, CI-like environments, and an explicit `--no-tui`. The flow, the
 * decision logic, and the safe-default contract are all the engine's; only the
 * rendering differs, so the two paths can never drift in behaviour.
 *
 * Prompting requires an interactive stdin. When stdin is not a TTY there is no
 * one to answer, so {@link runSequentialSetup} fails fast with actionable
 * guidance instead of hanging on a prompt that can never be satisfied.
 *
 * The I/O is abstracted behind {@link SequentialIo} so the prompt mapping and
 * reporter can be unit-tested with a scripted in-memory transcript — no TTY,
 * Docker, or readline required.
 */

import { createInterface } from "node:readline/promises";
import type { GithubAuthMode } from "@propr/shared";
import {
  runSetup,
  type GithubAuthDecision,
  type RepoSelection,
  type RootDecision,
  type RunSetupOptions,
  type SetupPrompts,
  type SetupReporter,
  type SetupRunResult,
} from "./engine.js";
import type { SetupStepStatus } from "./types.js";

// ---------------------------------------------------------------------------
// I/O seam.
// ---------------------------------------------------------------------------

/**
 * The line-oriented I/O the sequential wizard needs. The default
 * implementation ({@link createReadlineIo}) binds to `readline/promises`; tests
 * inject a scripted version to drive the whole flow without a terminal.
 */
export interface SequentialIo {
  /** Print one line to the user (a blank call prints an empty line). */
  print(line?: string): void;
  /**
   * Ask `question` and resolve with the user's answer (without the trailing
   * newline). When `mask` is set the typed characters are not echoed, so
   * secrets like relay tokens don't linger on screen or in scrollback.
   */
  ask(question: string, opts?: { mask?: boolean }): Promise<string>;
  /** Release any held resources (e.g. close the readline interface). */
  close(): void;
}

const ANSI = {
  reset: "[0m",
  bold: "[1m",
  dim: "[2m",
  red: "[31m",
  green: "[32m",
  yellow: "[33m",
  cyan: "[36m",
} as const;

/** A `(text) => styled text` painter, a no-op when color is disabled. */
type Paint = (text: string, ...codes: string[]) => string;

function makePaint(enabled: boolean): Paint {
  return (text, ...codes) => (enabled ? `${codes.join("")}${text}${ANSI.reset}` : text);
}

/**
 * A {@link SequentialIo} backed by `readline/promises` over the given streams.
 * Masked questions suppress keystroke echo by intercepting readline's internal
 * output writer — the prompt itself is drawn normally, only what the user types
 * afterwards is hidden (the same behaviour as a password prompt).
 */
export function createReadlineIo(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout
): SequentialIo {
  const rl = createInterface({ input, output });
  let muted = false;
  // readline echoes input by writing through `_writeToOutput`; override it so a
  // masked question can swallow keystroke echo while still emitting newlines so
  // the cursor advances when the user submits. Falls back gracefully: if the
  // internal hook is ever absent, input simply stays visible.
  const internal = rl as unknown as { _writeToOutput?(chunk: string): void };
  if (typeof internal._writeToOutput === "function") {
    internal._writeToOutput = (chunk: string): void => {
      if (muted) {
        if (chunk.includes("\n")) output.write("\n");
        return;
      }
      output.write(chunk);
    };
  }
  return {
    print(line = "") {
      output.write(`${line}\n`);
    },
    async ask(question, opts) {
      // Draw the prompt unmuted, then mute so only the typed answer is hidden.
      const answer = rl.question(question);
      muted = Boolean(opts?.mask);
      try {
        return await answer;
      } finally {
        muted = false;
      }
    },
    close() {
      rl.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Prompt primitives.
// ---------------------------------------------------------------------------

/** One selectable option, mirroring the Ink renderer's option shape. */
interface Option {
  label: string;
  value: string;
  /** Short dimmed suffix shown after the label (e.g. "detected"). */
  hint?: string;
}

/** Print a prompt's heading: a blank line, the title, then an optional detail. */
function printHeading(io: SequentialIo, paint: Paint, title: string, detail?: string): void {
  io.print();
  io.print(paint(title, ANSI.bold, ANSI.cyan));
  if (detail) io.print(paint(detail, ANSI.dim));
}

async function promptConfirm(
  io: SequentialIo,
  paint: Paint,
  req: { title: string; detail?: string; defaultValue?: boolean }
): Promise<boolean> {
  printHeading(io, paint, req.title, req.detail);
  const def = req.defaultValue ?? false;
  const suffix = def ? "[Y/n]" : "[y/N]";
  for (;;) {
    const answer = (await io.ask(`  ${paint("❯", ANSI.cyan)} ${suffix} `)).trim().toLowerCase();
    if (answer === "") return def;
    if (answer === "y" || answer === "yes") return true;
    if (answer === "n" || answer === "no") return false;
    io.print(paint("  Please answer y or n.", ANSI.yellow));
  }
}

async function promptInput(
  io: SequentialIo,
  paint: Paint,
  req: { title: string; detail?: string; defaultValue?: string; mask?: boolean }
): Promise<string> {
  printHeading(io, paint, req.title, req.detail);
  const def = req.defaultValue ?? "";
  const shownDefault = req.mask ? "•".repeat(def.length) : def;
  const hint = def ? paint(` (blank → ${shownDefault})`, ANSI.dim) : "";
  const answer = await io.ask(`  ${paint("❯", ANSI.cyan)}${hint} `, { mask: req.mask });
  // Mirror the Ink input exactly: a blank entry falls back to the default,
  // otherwise the raw text is returned for the engine hook to trim/parse.
  return answer.length > 0 ? answer : def;
}

async function promptSelect(
  io: SequentialIo,
  paint: Paint,
  req: { title: string; detail?: string; options: Option[]; defaultIndex?: number }
): Promise<string> {
  printHeading(io, paint, req.title, req.detail);
  const defaultIndex = Math.min(Math.max(req.defaultIndex ?? 0, 0), req.options.length - 1);
  req.options.forEach((option, index) => {
    const marker = index === defaultIndex ? paint("›", ANSI.cyan) : " ";
    const hint = option.hint ? paint(` (${option.hint})`, ANSI.dim) : "";
    io.print(`  ${marker} ${index + 1}) ${option.label}${hint}`);
  });
  for (;;) {
    const answer = (await io.ask(`  ${paint("❯", ANSI.cyan)} choose 1-${req.options.length} (blank → ${defaultIndex + 1}) `)).trim();
    if (answer === "") return req.options[defaultIndex].value;
    const n = Number(answer);
    if (Number.isInteger(n) && n >= 1 && n <= req.options.length) return req.options[n - 1].value;
    io.print(paint(`  Enter a number between 1 and ${req.options.length}.`, ANSI.yellow));
  }
}

async function promptMultiSelect(
  io: SequentialIo,
  paint: Paint,
  req: { title: string; detail?: string; options: Option[]; defaultSelected?: string[] }
): Promise<string[]> {
  printHeading(io, paint, req.title, req.detail);
  const defaults = new Set(req.defaultSelected ?? []);
  req.options.forEach((option, index) => {
    const checked = defaults.has(option.value) ? "[x]" : "[ ]";
    const hint = option.hint ? paint(` (${option.hint})`, ANSI.dim) : "";
    io.print(`  ${index + 1}) ${checked} ${option.label}${hint}`);
  });
  io.print(paint('  Enter comma-separated numbers to select, blank to keep the defaults, or "none" for an empty set.', ANSI.dim));
  for (;;) {
    const answer = (await io.ask(`  ${paint("❯", ANSI.cyan)} numbers `)).trim();
    if (answer === "") return req.options.filter((o) => defaults.has(o.value)).map((o) => o.value);
    if (answer.toLowerCase() === "none") return [];
    const nums = answer
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
      .map(Number);
    if (nums.length > 0 && nums.every((n) => Number.isInteger(n) && n >= 1 && n <= req.options.length)) {
      // De-dupe (first occurrence wins) and preserve option order for a stable result.
      const picked = new Set(nums.map((n) => req.options[n - 1].value));
      return req.options.filter((o) => picked.has(o.value)).map((o) => o.value);
    }
    io.print(paint(`  Enter numbers between 1 and ${req.options.length}, separated by commas.`, ANSI.yellow));
  }
}

// ---------------------------------------------------------------------------
// Engine prompt hooks.
// ---------------------------------------------------------------------------

/**
 * Map the engine's typed prompt hooks onto the sequential primitives. The hook
 * bodies mirror {@link buildSetupPrompts} in ../../tui/SetupApp.tsx one-for-one
 * so both renderers honour the same safe defaults: a blank input or a "keep"
 * choice leaves existing configuration untouched.
 */
export function buildSequentialPrompts(io: SequentialIo, paint: Paint = makePaint(false)): SetupPrompts {
  return {
    async resolveStackRoot({ currentRoot, init }): Promise<RootDecision> {
      const entered = await promptInput(io, paint, {
        title: "Stack root directory",
        detail: init.initialized
          ? `A stack already exists at ${currentRoot}.`
          : `The stack will be scaffolded at ${currentRoot}.`,
        defaultValue: currentRoot,
      });
      const rootDir = entered.trim() || currentRoot;
      // Only offer a re-scaffold when the resolved root already looks complete;
      // an incomplete root is scaffolded by the engine regardless.
      let reinitialize = false;
      if (init.initialized && rootDir === currentRoot) {
        reinitialize = await promptConfirm(io, paint, {
          title: "Re-scaffold the stack?",
          detail: "Fill in any missing files. Your existing .env is preserved.",
          defaultValue: false,
        });
      }
      return { rootDir, reinitialize };
    },

    async selectAgents({ available, detected }): Promise<string[]> {
      const detectedSet = new Set(detected);
      return promptMultiSelect(io, paint, {
        title: "Select agents to enable",
        detail: "Their images are pulled and host credentials recorded in .env.",
        options: available.map((type) => ({
          label: type,
          value: type,
          hint: detectedSet.has(type) ? "detected" : undefined,
        })),
        defaultSelected: detected,
      });
    },

    async configureGithubAuth({ current }): Promise<GithubAuthDecision> {
      const choice = await promptSelect(io, paint, {
        title: "GitHub authentication",
        detail: `Currently detected: ${current.mode}.`,
        options: [
          { label: "Keep current configuration", value: "keep", hint: current.mode },
          { label: "GitHub App (mint tokens locally)", value: "app" },
          { label: "Token relay (shared app)", value: "relay" },
          { label: "Demo mode (no GitHub access)", value: "demo" },
        ],
        defaultIndex: 0,
      });
      if (choice === "keep") return { keep: true };
      if (choice === "demo") {
        return { mode: "demo", vars: { PROPR_DEMO_MODE: "true", GH_AUTH_MODE: "demo" } };
      }
      if (choice === "relay") {
        const relayUrl = await promptInput(io, paint, { title: "Relay URL", defaultValue: "" });
        const relayToken = await promptInput(io, paint, { title: "Relay token", defaultValue: "", mask: true });
        return { mode: "relay", vars: { GH_AUTH_MODE: "relay", RELAY_URL: relayUrl, RELAY_TOKEN: relayToken } };
      }
      const appId = await promptInput(io, paint, { title: "GitHub App ID", defaultValue: "" });
      const privateKeyPath = await promptInput(io, paint, { title: "Path to the App private key (.pem)", defaultValue: "" });
      const installationId = await promptInput(io, paint, { title: "Installation ID", defaultValue: "" });
      return {
        mode: "app" satisfies GithubAuthMode,
        vars: { GH_AUTH_MODE: "app", GH_APP_ID: appId, GH_PRIVATE_KEY_PATH: privateKeyPath, GH_INSTALLATION_ID: installationId },
      };
    },

    async confirmStartStack({ rootDir, alreadyRunning }): Promise<boolean> {
      // A running stack is reused without prompting — nothing to start.
      if (alreadyRunning) return true;
      return promptConfirm(io, paint, {
        title: "Start the stack now?",
        detail: `Launch the local control-plane services in ${rootDir}.`,
        defaultValue: true,
      });
    },

    async configureWhitelist({ current, demoMode }): Promise<string[] | null> {
      if (demoMode) return null;
      const entered = await promptInput(io, paint, {
        title: "Allowed GitHub usernames",
        detail: "Comma-separated; only these users can trigger ProPR. Blank keeps the current value.",
        defaultValue: current.join(", "),
      });
      const trimmed = entered.trim();
      if (trimmed === "") return null;
      return trimmed
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
    },

    async addRepository(): Promise<RepoSelection | null> {
      const add = await promptConfirm(io, paint, {
        title: "Connect a repository now?",
        detail: "Optionally add a first repository for ProPR to monitor.",
        defaultValue: false,
      });
      if (!add) return null;
      const fullName = (await promptInput(io, paint, { title: "Repository (owner/repo)", defaultValue: "" })).trim();
      if (!fullName) return null;
      const baseBranch = (await promptInput(io, paint, { title: "Base branch (optional, blank for the default)", defaultValue: "" })).trim();
      return { fullName, baseBranch: baseBranch || undefined };
    },

    async launchUi({ url }): Promise<boolean> {
      if (!url) return false;
      return promptConfirm(io, paint, { title: "Open the ProPR web UI?", detail: url, defaultValue: false });
    },
  };
}

// ---------------------------------------------------------------------------
// Progress reporting.
// ---------------------------------------------------------------------------

/** Terminal glyph + color for a settled step, mirroring the Ink status row. */
const SETTLED_GLYPH: Record<Exclude<SetupStepStatus, "active" | "pending">, { glyph: string; color: string }> = {
  done: { glyph: "✓", color: ANSI.green },
  skipped: { glyph: "−", color: ANSI.dim },
  warning: { glyph: "!", color: ANSI.yellow },
  failed: { glyph: "✗", color: ANSI.red },
};

/**
 * Build the reporter that streams the engine's progress as plain lines: a
 * heading when each step starts, a glyph + detail when it settles, and any log
 * lines in between. `onState` is intentionally unused — replaying the whole
 * step list on every transition reads as noise in a scrolling log, whereas the
 * Ink view repaints it in place.
 */
export function buildSequentialReporter(io: SequentialIo, paint: Paint = makePaint(false)): SetupReporter {
  return {
    onStepStart(step) {
      io.print();
      const optional = step.optional ? paint(" (optional)", ANSI.dim) : "";
      io.print(`${paint("▶", ANSI.cyan, ANSI.bold)} ${paint(step.title, ANSI.bold)}${optional}`);
      io.print(paint(`  ${step.description}`, ANSI.dim));
    },
    onStepSettled(step) {
      if (step.status === "active" || step.status === "pending") return;
      const { glyph, color } = SETTLED_GLYPH[step.status];
      io.print(`  ${paint(glyph, color)} ${step.detail ?? step.status}`);
      if (step.nextAction) io.print(`     ${paint("↳", ANSI.dim)} ${step.nextAction}`);
    },
    onLog(line) {
      io.print(paint(`  · ${line}`, ANSI.dim));
    },
  };
}

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

/**
 * Thrown when the sequential wizard cannot prompt because stdin is not an
 * interactive terminal. Carries actionable guidance in its message so the
 * command layer can print it verbatim and exit non-zero.
 */
export class SequentialSetupUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SequentialSetupUnavailableError";
  }
}

/** Options for {@link runSequentialSetup}: the engine's options plus I/O wiring. */
export interface SequentialSetupOptions extends RunSetupOptions {
  /** Inject the I/O seam (tests). When set, the TTY check is bypassed. */
  io?: SequentialIo;
  /** Input stream to read prompts from (default: process.stdin). */
  input?: NodeJS.ReadableStream & { isTTY?: boolean };
  /** Output stream to write to (default: process.stdout). */
  output?: NodeJS.WritableStream & { isTTY?: boolean };
  /** Force color on/off; defaults to "on when stdout is a TTY and NO_COLOR is unset". */
  color?: boolean;
}

/**
 * Run `propr setup` through the readline fallback wizard, reusing the shared
 * engine. Fails fast (without prompting) when stdin is not interactive.
 *
 * @throws {SequentialSetupUnavailableError} when stdin is not a TTY and no I/O
 *   seam was injected — there is no one to answer the prompts.
 */
export async function runSequentialSetup(options: SequentialSetupOptions = {}): Promise<SetupRunResult> {
  const { io: injectedIo, input = process.stdin, output = process.stdout, color, ...setupOptions } = options;

  // No interactive stdin means no one can answer the prompts; fail with guidance
  // rather than hang. Skipped when a test injects its own scripted I/O.
  if (!injectedIo && !input.isTTY) {
    throw new SequentialSetupUnavailableError(
      [
        "`propr setup` needs an interactive terminal to ask you questions, but stdin is not a TTY",
        "(it looks piped, redirected, or running under CI).",
        "",
        "Run `propr setup` directly in an interactive shell, or configure the stack without prompts:",
        "  • `propr init stack`, then edit <root>/.env by hand and run `propr start`",
        "  • or pre-set the values in <root>/.env before re-running setup",
      ].join("\n")
    );
  }

  const colorEnabled = color ?? (Boolean(output.isTTY) && process.env.NO_COLOR === undefined);
  const paint = makePaint(colorEnabled);
  const io = injectedIo ?? createReadlineIo(input, output);

  io.print(paint("ProPR setup", ANSI.bold));
  io.print(paint("Running the sequential wizard (no interactive TUI).", ANSI.dim));

  try {
    const result = await runSetup({
      ...setupOptions,
      prompts: buildSequentialPrompts(io, paint),
      reporter: buildSequentialReporter(io, paint),
    });

    io.print();
    if (result.completed) {
      io.print(paint("✓ Setup complete.", ANSI.green, ANSI.bold));
    } else {
      io.print(paint("✗ Setup did not finish — see the failed step above and re-run `propr setup`.", ANSI.red, ANSI.bold));
    }
    return result;
  } finally {
    io.close();
  }
}
