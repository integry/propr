/**
 * Interactive Ink view for `propr setup`.
 *
 * The setup engine (../commands/setup/engine.ts) is UI-agnostic: it emits state
 * through a {@link SetupReporter} and collects user decisions through optional
 * {@link SetupPrompts} hooks. This module bridges both seams to Ink.
 *
 *   - {@link SetupBridge} is the pub/sub bridge. The engine's reporter pushes
 *     state/log events into it; its prompt primitives (confirm / input / single
 *     choice / multi choice) let the engine's prompt hooks request a decision and
 *     await the user's answer. Only one prompt is ever in flight because the
 *     engine runs steps sequentially.
 *   - {@link SetupApp} subscribes to the bridge, renders every step with its
 *     status/title/detail, streams recent log lines, and renders the active
 *     prompt with keyboard navigation (choices) or text entry (inputs).
 *   - {@link buildSetupPrompts} maps the engine's typed prompt hooks onto the
 *     bridge primitives.
 *
 * Ctrl-C cancels: it rejects any in-flight prompt (so the engine unwinds and
 * `runSetup` resolves) and exits the Ink app so no session is left running.
 */

import React, { useEffect, useReducer, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { DEFAULT_PROPR_GH_RELAY_URL, type GithubAuthMode } from "@propr/shared";
import type { AuthorizedInstallation } from "../api/relay.js";
import type {
  SetupPrompts,
  GithubAuthDecision,
  RepoSelection,
  RootDecision,
} from "../commands/setup/engine.js";
import {
  INTAKE_DOCS_URL,
  WEBHOOK_DOCS_URL,
  intakeModeOptions,
  type GithubIntakeDecision,
  type GithubIntakeMode,
} from "../commands/setup/github.js";
import type { SetupState, SetupStep, SetupStepStatus } from "../commands/setup/types.js";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const MAX_LOG_LINES = 8;

/** Thrown into a pending prompt when the user cancels with Ctrl-C. */
export class SetupCancelledError extends Error {
  constructor() {
    super("setup cancelled");
    this.name = "SetupCancelledError";
  }
}

/** A single selectable option for a choice prompt. */
export interface SetupPromptOption {
  label: string;
  value: string;
  /** Short suffix shown dimmed after the label (e.g. "detected"). */
  hint?: string;
  /**
   * When true the option is rendered inactive, skipped by keyboard navigation,
   * and cannot be chosen — used for intake modes the current GitHub auth mode
   * can't support. The `hint` carries the reason.
   */
  disabled?: boolean;
}

interface BasePrompt {
  id: number;
  title: string;
  detail?: string;
}

/** A decision request the engine has handed to the UI. */
export type SetupPrompt =
  | (BasePrompt & { kind: "confirm"; defaultValue: boolean })
  | (BasePrompt & { kind: "input"; defaultValue: string; placeholder?: string; mask?: boolean })
  | (BasePrompt & { kind: "select"; options: SetupPromptOption[]; defaultIndex: number })
  | (BasePrompt & { kind: "multi"; options: SetupPromptOption[]; defaultSelected: string[] });

type SetupUiEvent =
  | { type: "state"; state: SetupState }
  | { type: "log"; line: string }
  | { type: "prompt"; prompt: SetupPrompt }
  | { type: "prompt-done"; id: number }
  | { type: "done" };

/**
 * Pub/sub bridge between the async setup engine and the React tree, plus the
 * prompt primitives the engine's hooks call to collect a decision and wait for
 * the user. The same history-replay pattern as CheckHub guarantees that events
 * emitted before the component subscribes are still delivered exactly once.
 */
export class SetupBridge {
  private listeners = new Set<(event: SetupUiEvent) => void>();
  private history: SetupUiEvent[] = [];
  private nextId = 1;
  private resolvers = new Map<number, (value: unknown) => void>();
  private rejecters = new Map<number, (error: unknown) => void>();
  private cancelled = false;

  private push(event: SetupUiEvent): void {
    this.history.push(event);
    for (const listener of [...this.listeners]) listener(event);
  }

  subscribe(listener: (event: SetupUiEvent) => void): () => void {
    this.listeners.add(listener);
    for (const event of this.history) listener(event);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // --- engine → UI -------------------------------------------------------

  emitState(state: SetupState): void {
    this.push({ type: "state", state });
  }

  emitLog(line: string): void {
    this.push({ type: "log", line });
  }

  /** Reflect the final state and tell the view the engine is finished. */
  finish(state: SetupState): void {
    this.push({ type: "state", state });
    this.push({ type: "done" });
  }

  // --- engine prompt primitives (return a promise the UI resolves) -------

  private request<T>(make: (id: number) => SetupPrompt): Promise<T> {
    // After cancellation every further prompt rejects immediately so the engine
    // unwinds instead of blocking on a view that is already gone.
    if (this.cancelled) return Promise.reject(new SetupCancelledError());
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.resolvers.set(id, resolve as (value: unknown) => void);
      this.rejecters.set(id, reject);
      this.push({ type: "prompt", prompt: make(id) });
    });
  }

  confirm(req: { title: string; detail?: string; defaultValue?: boolean }): Promise<boolean> {
    return this.request<boolean>((id) => ({
      id,
      kind: "confirm",
      title: req.title,
      detail: req.detail,
      defaultValue: req.defaultValue ?? false,
    }));
  }

  input(req: { title: string; detail?: string; defaultValue?: string; placeholder?: string; mask?: boolean }): Promise<string> {
    return this.request<string>((id) => ({
      id,
      kind: "input",
      title: req.title,
      detail: req.detail,
      defaultValue: req.defaultValue ?? "",
      placeholder: req.placeholder,
      mask: req.mask,
    }));
  }

  select(req: { title: string; detail?: string; options: SetupPromptOption[]; defaultIndex?: number }): Promise<string> {
    return this.request<string>((id) => ({
      id,
      kind: "select",
      title: req.title,
      detail: req.detail,
      options: req.options,
      defaultIndex: req.defaultIndex ?? 0,
    }));
  }

  multiSelect(req: { title: string; detail?: string; options: SetupPromptOption[]; defaultSelected?: string[] }): Promise<string[]> {
    return this.request<string[]>((id) => ({
      id,
      kind: "multi",
      title: req.title,
      detail: req.detail,
      options: req.options,
      defaultSelected: req.defaultSelected ?? [],
    }));
  }

  // --- UI → engine -------------------------------------------------------

  /** Resolve the in-flight prompt with the user's answer. */
  resolve(id: number, value: unknown): void {
    const resolve = this.resolvers.get(id);
    if (!resolve) return;
    this.resolvers.delete(id);
    this.rejecters.delete(id);
    this.push({ type: "prompt-done", id });
    resolve(value);
  }

  /** Reject any in-flight prompt; further prompts reject immediately. */
  cancel(): void {
    this.cancelled = true;
    const pending = [...this.rejecters.entries()];
    this.resolvers.clear();
    this.rejecters.clear();
    for (const [, reject] of pending) reject(new SetupCancelledError());
  }
}

/**
 * Map the engine's typed prompt hooks onto the bridge primitives. Every hook
 * keeps the engine's safe-default contract: a blank input or a "keep" choice
 * leaves existing configuration untouched.
 */
export function buildSetupPrompts(bridge: SetupBridge): SetupPrompts {
  return {
    async resolveStackRoot({ currentRoot, init }): Promise<RootDecision> {
      const entered = await bridge.input({
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
        reinitialize = await bridge.confirm({
          title: "Re-scaffold the stack?",
          detail: "Fill in any missing files. Your existing .env is preserved.",
          defaultValue: false,
        });
      }
      return { rootDir, reinitialize };
    },

    async selectAgents({ available, detected }): Promise<string[]> {
      const detectedSet = new Set(detected);
      return bridge.multiSelect({
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
      // Token relay (the hosted ProPR GitHub App) leads as the recommended path.
      // "Keep current configuration" is offered only when there is an existing
      // config to keep — on a fresh install there is nothing to preserve, so the
      // relay option is the first (and default) choice.
      const options: SetupPromptOption[] = [];
      if (current.mode !== "none") {
        options.push({ label: "Keep current configuration", value: "keep", hint: current.mode });
      }
      options.push({ label: "Token relay (use the ProPR GitHub App)", value: "relay" });
      options.push({ label: "Custom GitHub App (set up your own GitHub App)", value: "app" });
      const choice = await bridge.select({
        title: "GitHub authentication",
        detail: `Currently detected: ${current.mode}.`,
        options,
        defaultIndex: 0,
      });
      if (choice === "keep") return { keep: true };
      // Switching to a real auth mode must explicitly turn demo mode off:
      // detectGithubAuthMode reads PROPR_DEMO_MODE, so a leftover
      // PROPR_DEMO_MODE=true would keep resolving as demo and ignore the App/relay
      // config the user just entered.
      if (choice === "relay") {
        // No manual URL/token entry: the engine enrolls with the hosted relay
        // using the stored `propr login` token, discovers the installation, and
        // mints the token. Only the relay base URL is asked, prefilled with the
        // hosted default (Enter accepts it; override for a self-hosted relay).
        const relayUrl = await bridge.input({
          title: "Relay URL",
          detail: "Press Enter for the hosted ProPR relay; override only for a self-hosted relay.",
          defaultValue: DEFAULT_PROPR_GH_RELAY_URL,
        });
        return { mode: "relay", enrollRelay: { relayUrl: relayUrl.trim() || DEFAULT_PROPR_GH_RELAY_URL } };
      }
      const appId = await bridge.input({ title: "GitHub App ID", defaultValue: "" });
      // The CLI stack bind-mounts the key from the host via HOST_GH_PRIVATE_KEY
      // (NOT the in-container GH_PRIVATE_KEY_PATH, which is the launcher path) —
      // so `propr start` can find it. Ask for the host path and write that key.
      const privateKeyPath = await bridge.input({ title: "Host path to the App private key (.pem)", defaultValue: "" });
      const installationId = await bridge.input({ title: "Installation ID", defaultValue: "" });
      return {
        mode: "app" satisfies GithubAuthMode,
        vars: { PROPR_DEMO_MODE: "false", GH_AUTH_MODE: "app", GH_APP_ID: appId, HOST_GH_PRIVATE_KEY: privateKeyPath, GH_INSTALLATION_ID: installationId },
      };
    },

    // Note: confirmGithubLogin is intentionally not implemented here. The
    // interactive `gh auth login` would have to take over the terminal mid-render,
    // which the full-screen Ink wizard can't do cleanly — so relay enrollment
    // without a stored token surfaces "run `propr login`" guidance instead
    // (see enrollRelayForSetup in engine.ts).
    async selectInstallation({ installations }): Promise<string> {
      return bridge.select({
        title: "Choose a GitHub App installation",
        detail: "Your account can access more than one; the relay token is minted for the one you pick.",
        options: installations.map((i: AuthorizedInstallation) => ({
          label: `${i.account_login} (${i.account_type})`,
          value: String(i.installation_id),
          hint: String(i.installation_id),
        })),
        defaultIndex: 0,
      });
    },

    async configureIntake({ authMode, defaultMode, currentMode }): Promise<GithubIntakeDecision> {
      // Only some intake modes are valid for the chosen auth mode (e.g. direct
      // webhooks need an own GitHub App, the routing WebSocket needs the ProPR
      // relay). Show every mode, but mark the unsupported ones inactive with the
      // reason so the user understands why a path is closed.
      const baseLabel: Record<GithubIntakeMode, string> = {
        routing_websocket: "Routing WebSocket — hosted ProPR relay (recommended)",
        polling: "Polling (no inbound webhooks)",
        direct_webhook: "Direct webhooks (own GitHub App + a signing secret)",
      };
      const options: SetupPromptOption[] = intakeModeOptions(authMode).map((opt) => ({
        label: baseLabel[opt.mode],
        value: opt.mode,
        hint: opt.note,
        disabled: !opt.available,
      }));
      options.push({ label: "Keep current", value: "keep", hint: currentMode });
      let defaultIndex = Math.max(0, options.findIndex((o) => o.value === defaultMode));
      // If the recommended default isn't valid for this auth mode, fall back to
      // the first selectable option rather than pre-selecting a disabled one.
      if (options[defaultIndex]?.disabled) defaultIndex = options.findIndex((o) => !o.disabled);
      const choice = await bridge.select({
        title: "GitHub event intake",
        detail: `How the backend receives GitHub events. Docs: ${INTAKE_DOCS_URL}`,
        options,
        defaultIndex,
      });
      if (choice === "keep") return { keep: true };
      if (choice === "direct_webhook") {
        // The API refuses to boot in direct_webhook mode with no secret — keep
        // asking until a non-empty secret is entered.
        let secret = "";
        while (secret === "") {
          secret = (
            await bridge.input({
              title: "Webhook signing secret",
              detail: `Verifies GitHub webhook signatures; forged payloads are rejected. Docs: ${WEBHOOK_DOCS_URL}`,
              mask: true,
            })
          ).trim();
        }
        return { mode: "direct_webhook", webhookSecret: secret };
      }
      return { mode: choice as GithubIntakeMode };
    },

    async confirmStartStack({ rootDir, alreadyRunning }): Promise<boolean> {
      // A running stack is reused without prompting — nothing to start.
      if (alreadyRunning) return true;
      return bridge.confirm({
        title: "Start the stack now?",
        detail: `Launch the local control-plane services in ${rootDir}.`,
        defaultValue: true,
      });
    },

    async confirmAgentLogin({ candidates }): Promise<string[]> {
      return bridge.multiSelect({
        title: "Authenticate agents through their images?",
        detail: "Log in inside each agent's Docker image; credentials are written to the mounted host directory. Leave empty to skip.",
        options: candidates.map((type) => ({ label: type, value: type })),
        defaultSelected: [],
      });
    },

    async configureWhitelist({ current, demoMode }): Promise<string[] | null> {
      if (demoMode) return null;
      const entered = await bridge.input({
        title: "Allowed GitHub usernames",
        detail: 'Comma-separated; only these users can trigger ProPR. Blank keeps the current value, "none" clears it.',
        defaultValue: current.join(", "),
      });
      const trimmed = entered.trim();
      if (trimmed === "") return null;
      // An explicit "none" empties the whitelist, mirroring the sequential
      // renderer — without this it would be parsed as a literal username "none".
      if (trimmed.toLowerCase() === "none") return [];
      return trimmed
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
    },

    async addRepository(): Promise<RepoSelection | null> {
      const add = await bridge.confirm({
        title: "Connect a repository now?",
        detail: "Optionally add a first repository for ProPR to monitor.",
        defaultValue: false,
      });
      if (!add) return null;
      const fullName = (await bridge.input({ title: "Repository (owner/repo)", defaultValue: "" })).trim();
      if (!fullName) return null;
      const baseBranch = (await bridge.input({ title: "Base branch (optional, blank for the default)", defaultValue: "" })).trim();
      return { fullName, baseBranch: baseBranch || undefined };
    },

    async launchUi({ url }): Promise<boolean> {
      if (!url) return false;
      return bridge.confirm({ title: "Open the ProPR web UI?", detail: url, defaultValue: false });
    },
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const STATUS_GLYPH: Record<Exclude<SetupStepStatus, "active">, string> = {
  pending: "○",
  done: "✓",
  skipped: "−",
  warning: "!",
  failed: "✗",
};

function statusColor(status: SetupStepStatus): string | undefined {
  switch (status) {
    case "done":
      return "green";
    case "warning":
      return "yellow";
    case "failed":
      return "red";
    case "active":
      return "cyan";
    default:
      return "gray";
  }
}

function StepGlyph({ status, frame }: { status: SetupStepStatus; frame: number }): React.ReactElement {
  if (status === "active") {
    return <Text color="cyan">{SPINNER[frame % SPINNER.length]}</Text>;
  }
  return <Text color={statusColor(status)}>{STATUS_GLYPH[status]}</Text>;
}

function StepRow({ step, frame }: { step: SetupStep; frame: number }): React.ReactElement {
  const active = step.status === "active";
  return (
    <Box flexDirection="column">
      <Box>
        <Box flexShrink={0} marginRight={1}>
          <StepGlyph status={step.status} frame={frame} />
        </Box>
        <Text bold={active} color={active ? "cyan" : undefined}>
          {step.title}
        </Text>
        {step.optional ? <Text dimColor> (optional)</Text> : null}
      </Box>
      {step.detail ? (
        <Box paddingLeft={2}>
          <Text color={statusColor(step.status)} dimColor={step.status !== "failed" && step.status !== "warning"}>
            {step.detail}
          </Text>
        </Box>
      ) : null}
      {step.nextAction ? (
        <Box paddingLeft={2}>
          <Text dimColor>↳ {step.nextAction}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

function PromptHeader({ prompt }: { prompt: SetupPrompt }): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Text color="cyan" bold>
        {prompt.title}
      </Text>
      {prompt.detail ? <Text dimColor>{prompt.detail}</Text> : null}
    </Box>
  );
}

interface PromptViewProps {
  prompt: SetupPrompt;
  text: string;
  cursor: number;
  highlighted: number;
  selected: Set<string>;
}

function PromptView(props: PromptViewProps): React.ReactElement {
  const { prompt } = props;
  if (prompt.kind === "confirm") {
    const yes = props.highlighted === 0;
    return (
      <Box flexDirection="column" marginTop={1}>
        <PromptHeader prompt={prompt} />
        <Box marginTop={1}>
          <Text color={yes ? "cyan" : undefined} bold={yes}>
            {yes ? "❯ " : "  "}Yes
          </Text>
          <Text> </Text>
          <Text color={!yes ? "cyan" : undefined} bold={!yes}>
            {!yes ? "❯ " : "  "}No
          </Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>←/→ or y/n select · enter confirm · Ctrl-C cancel</Text>
        </Box>
      </Box>
    );
  }

  if (prompt.kind === "input") {
    const shown = prompt.mask ? "•".repeat(props.text.length) : props.text;
    const before = shown.slice(0, props.cursor);
    const at = shown.slice(props.cursor, props.cursor + 1) || " ";
    const after = shown.slice(props.cursor + 1);
    const empty = props.text.length === 0;
    return (
      <Box flexDirection="column" marginTop={1}>
        <PromptHeader prompt={prompt} />
        <Box marginTop={1}>
          <Text>❯ </Text>
          {empty && prompt.placeholder ? (
            <Text dimColor>{prompt.placeholder}</Text>
          ) : (
            <Text>
              {before}
              <Text inverse>{at}</Text>
              {after}
            </Text>
          )}
        </Box>
        <Box marginTop={1}>
          <Text dimColor>
            enter submit{prompt.defaultValue ? ` (blank → ${prompt.mask ? "•".repeat(prompt.defaultValue.length) : prompt.defaultValue})` : ""} · Ctrl-C cancel
          </Text>
        </Box>
      </Box>
    );
  }

  if (prompt.kind === "select") {
    return (
      <Box flexDirection="column" marginTop={1}>
        <PromptHeader prompt={prompt} />
        <Box flexDirection="column" marginTop={1}>
          {prompt.options.map((option, index) => {
            const active = index === props.highlighted;
            const disabled = option.disabled ?? false;
            return (
              <Box key={option.value}>
                <Text color={active ? "cyan" : undefined} bold={active} dimColor={disabled && !active}>
                  {active ? "❯ " : "  "}
                  {option.label}
                  {disabled ? " — unavailable" : ""}
                </Text>
                {option.hint ? <Text dimColor> ({option.hint})</Text> : null}
              </Box>
            );
          })}
        </Box>
        <Box marginTop={1}>
          <Text dimColor>↑/↓ select · enter choose · Ctrl-C cancel</Text>
        </Box>
      </Box>
    );
  }

  // multi
  return (
    <Box flexDirection="column" marginTop={1}>
      <PromptHeader prompt={prompt} />
      <Box flexDirection="column" marginTop={1}>
        {prompt.options.map((option, index) => {
          const active = index === props.highlighted;
          const checked = props.selected.has(option.value);
          return (
            <Box key={option.value}>
              <Text color={active ? "cyan" : undefined} bold={active}>
                {active ? "❯ " : "  "}
                {checked ? "[x] " : "[ ] "}
                {option.label}
              </Text>
              {option.hint ? <Text dimColor> ({option.hint})</Text> : null}
            </Box>
          );
        })}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>↑/↓ move · space toggle · enter confirm · Ctrl-C cancel</Text>
      </Box>
    </Box>
  );
}

interface UiState {
  setup: SetupState | null;
  logs: string[];
  prompt: SetupPrompt | null;
  done: boolean;
}

function uiReducer(state: UiState, event: SetupUiEvent): UiState {
  switch (event.type) {
    case "state":
      return { ...state, setup: event.state };
    case "log":
      return { ...state, logs: [...state.logs, event.line].slice(-MAX_LOG_LINES) };
    case "prompt":
      return { ...state, prompt: event.prompt };
    case "prompt-done":
      return state.prompt && state.prompt.id === event.id ? { ...state, prompt: null } : state;
    case "done":
      return { ...state, done: true, prompt: null };
    default:
      return state;
  }
}

export interface SetupAppProps {
  bridge: SetupBridge;
  /** Invoked when the user cancels with Ctrl-C, before the app exits. */
  onCancel?: () => void;
}

export function SetupApp({ bridge, onCancel }: SetupAppProps): React.ReactElement {
  const { exit } = useApp();
  const [ui, dispatch] = useReducer(uiReducer, { setup: null, logs: [], prompt: null, done: false });
  const [frame, setFrame] = useState(0);

  // Per-prompt local input state, reset whenever a new prompt arrives.
  const [text, setText] = useState("");
  const [cursor, setCursor] = useState(0);
  const [highlighted, setHighlighted] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());

  useEffect(() => bridge.subscribe(dispatch), [bridge]);

  const prompt = ui.prompt;
  const promptId = prompt?.id;

  useEffect(() => {
    if (!prompt) return;
    if (prompt.kind === "input") {
      setText("");
      setCursor(0);
    } else if (prompt.kind === "confirm") {
      setHighlighted(prompt.defaultValue ? 0 : 1);
    } else if (prompt.kind === "select") {
      let idx = Math.min(Math.max(prompt.defaultIndex, 0), prompt.options.length - 1);
      // Never start the highlight on a disabled option.
      if (prompt.options[idx]?.disabled) {
        const firstEnabled = prompt.options.findIndex((o) => !o.disabled);
        if (firstEnabled !== -1) idx = firstEnabled;
      }
      setHighlighted(idx);
    } else {
      setHighlighted(0);
      setSelected(new Set(prompt.defaultSelected));
    }
    // Keyed on the prompt id so each distinct request reinitializes cleanly.
  }, [promptId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Animate the spinner while the engine is still working.
  useEffect(() => {
    if (ui.done) return;
    const timer = setInterval(() => setFrame((f) => f + 1), 80);
    return () => clearInterval(timer);
  }, [ui.done]);

  // Let the final frame paint, then unmount so renderSetupWizard resolves.
  useEffect(() => {
    if (!ui.done) return;
    const timer = setTimeout(() => exit(), 40);
    return () => clearTimeout(timer);
  }, [ui.done, exit]);

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      onCancel?.();
      bridge.cancel();
      exit();
      return;
    }
    if (!prompt) return;

    if (prompt.kind === "confirm") {
      if (key.leftArrow || key.rightArrow) setHighlighted((h) => (h === 0 ? 1 : 0));
      else if (input.toLowerCase() === "y") bridge.resolve(prompt.id, true);
      else if (input.toLowerCase() === "n") bridge.resolve(prompt.id, false);
      else if (key.return) bridge.resolve(prompt.id, highlighted === 0);
      return;
    }

    if (prompt.kind === "input") {
      if (key.return) {
        const value = text.length > 0 ? text : prompt.defaultValue;
        bridge.resolve(prompt.id, value);
      } else if (key.leftArrow) {
        setCursor((c) => Math.max(0, c - 1));
      } else if (key.rightArrow) {
        setCursor((c) => Math.min(text.length, c + 1));
      } else if (key.backspace || key.delete) {
        if (cursor > 0) {
          setText((t) => t.slice(0, cursor - 1) + t.slice(cursor));
          setCursor((c) => Math.max(0, c - 1));
        }
      } else if (input && !key.ctrl && !key.meta && !key.upArrow && !key.downArrow) {
        setText((t) => t.slice(0, cursor) + input + t.slice(cursor));
        setCursor((c) => c + input.length);
      }
      return;
    }

    if (prompt.kind === "select") {
      const count = prompt.options.length;
      // Step over disabled options so the highlight only ever rests on a choice
      // the user can actually pick.
      const step = (from: number, dir: number): number => {
        for (let k = 1; k <= count; k++) {
          const i = (from + dir * k + count * k) % count;
          if (!prompt.options[i].disabled) return i;
        }
        return from;
      };
      if (key.upArrow) setHighlighted((h) => step(h, -1));
      else if (key.downArrow) setHighlighted((h) => step(h, 1));
      else if (key.return && !prompt.options[highlighted].disabled) {
        bridge.resolve(prompt.id, prompt.options[highlighted].value);
      }
      return;
    }

    // multi
    const count = prompt.options.length;
    // With no options there is nothing to highlight or toggle — mirror the
    // sequential wizard, which skips the prompt entirely and yields []. Only Enter
    // is meaningful (it resolves to the empty set); arrow/space are ignored so we
    // never index an empty array or compute a NaN highlight (`h % 0`).
    if (count === 0) {
      if (key.return) bridge.resolve(prompt.id, []);
      return;
    }
    if (key.upArrow) setHighlighted((h) => (h - 1 + count) % count);
    else if (key.downArrow) setHighlighted((h) => (h + 1) % count);
    else if (input === " ") {
      const value = prompt.options[highlighted].value;
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(value)) next.delete(value);
        else next.add(value);
        return next;
      });
    } else if (key.return) {
      const chosen = prompt.options.filter((option) => selected.has(option.value)).map((option) => option.value);
      bridge.resolve(prompt.id, chosen);
    }
  });

  const setup = ui.setup;

  return (
    <Box flexDirection="column">
      <Box>
        <Text bold>ProPR setup</Text>
        {setup ? <Text dimColor>  (stack root: {setup.rootDir})</Text> : null}
      </Box>

      <Box flexDirection="column" marginTop={1}>
        {setup ? (
          setup.steps.map((step) => <StepRow key={step.id} step={step} frame={frame} />)
        ) : (
          <Text dimColor>{SPINNER[frame % SPINNER.length]} preparing…</Text>
        )}
      </Box>

      {ui.logs.length > 0 && !ui.done ? (
        <Box flexDirection="column" marginTop={1}>
          {ui.logs.map((line, index) => (
            <Text key={index} dimColor>
              {line}
            </Text>
          ))}
        </Box>
      ) : null}

      {prompt && !ui.done ? (
        <PromptView prompt={prompt} text={text} cursor={cursor} highlighted={highlighted} selected={selected} />
      ) : null}

      {ui.done ? (
        <Box marginTop={1}>
          <Text dimColor>Setup finished.</Text>
        </Box>
      ) : null}
    </Box>
  );
}
