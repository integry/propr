/**
 * ink entry — renders the live dashboard and resolves with the exit outcome
 * ("background" if the user left the stack running, "stopped" if they stopped it).
 */

import React from "react";
import { render } from "ink";
import { StartApp } from "./StartApp.js";
import { CheckApp, CheckHub, type RemediationMenuItem } from "./CheckApp.js";
import { AgentTableApp, AgentTableHub } from "./AgentTableApp.js";
import { SetupApp, SetupBridge, buildSetupPrompts } from "./SetupApp.js";
import type { OrchestratorConfig, OrchestratorModule } from "../orchestrator/index.js";
import type { ConfigManager } from "../config/index.js";
import { runChecks, type ChecksOutcome, type RunChecksOptions } from "../commands/checkCommands.js";
import { validateAgents, agentTypesFor, type AgentValidationRow } from "../commands/agentValidation.js";
import { runSetup, type RunSetupOptions, type SetupReporter, type SetupRunResult } from "../commands/setup/engine.js";

export interface DashboardProps {
  orch: OrchestratorModule;
  cfg: OrchestratorConfig;
  configManager?: ConfigManager;
}

export async function renderDashboard(props: DashboardProps): Promise<"background" | "stopped"> {
  const result: { outcome: "background" | "stopped" } = { outcome: "background" };
  const instance = render(
    <StartApp orch={props.orch} cfg={props.cfg} configManager={props.configManager} onResult={(o) => { result.outcome = o; }} />,
    { exitOnCtrlC: false },
  );
  await instance.waitUntilExit();
  return result.outcome;
}

/**
 * Render a single live check pass in an interactive terminal. The check engine
 * streams results into the Ink view (spinners while slow checks run); with
 * `fix`, the view ends in an arrow-key remediation menu. Resolves with the
 * finished outcome and the remediation key the user selected (if any) so the
 * caller can run that action outside the Ink tree.
 */
export async function renderLiveChecks(
  runOptions: RunChecksOptions,
  opts: { fix?: boolean; showAgentValidationHint?: boolean; getActions: (outcome: ChecksOutcome) => RemediationMenuItem[] }
): Promise<{ outcome: ChecksOutcome | undefined; selectedKey: string | undefined }> {
  const hub = new CheckHub();
  let selectedKey: string | undefined;
  let cancelled = false;
  const instance = render(
    <CheckApp
      hub={hub}
      fix={Boolean(opts.fix)}
      getActions={opts.getActions}
      onSelect={(key) => { selectedKey = key; }}
      onCancel={() => { cancelled = true; }}
      showAgentValidationHint={Boolean(opts.showAgentValidationHint)}
    />,
    { exitOnCtrlC: false },
  );

  let engineError: Error | undefined;
  const outcomePromise = runChecks({
    ...runOptions,
    onPending: (slot) => hub.emit({ type: "pending", slot }),
    onResult: (result) => hub.emit({ type: "result", result }),
  })
    .then((outcome) => {
      hub.emit({ type: "done", outcome });
      return outcome;
    })
    .catch((error: Error) => {
      engineError = error;
      hub.emit({ type: "error", error });
      return undefined;
    });

  await instance.waitUntilExit();
  if (cancelled) return { outcome: undefined, selectedKey: undefined };
  const outcome = await outcomePromise;
  if (engineError) throw engineError;
  return { outcome, selectedKey };
}

/**
 * Render the agent validation as a live table: rows appear immediately with
 * spinners and each cell fills in as its check resolves. Returns the finished
 * rows so the caller can print the raw responses below.
 */
export async function renderAgentValidation(
  orch: OrchestratorModule,
  cfg: OrchestratorConfig,
  agentsFilter: string[] | undefined
): Promise<AgentValidationRow[]> {
  const hub = new AgentTableHub();
  const instance = render(<AgentTableApp agents={agentTypesFor(agentsFilter, cfg)} hub={hub} />, { exitOnCtrlC: false });

  try {
    const rows = await validateAgents(orch, cfg, {
      agents: agentsFilter,
      onUpdate: (agent, update) => hub.emit({ type: "update", agent, update }),
    });
    hub.emit({ type: "done" });
    await instance.waitUntilExit();
    return rows;
  } catch (error) {
    // Without this, a throw before the "done" event leaves the Ink app mounted
    // and waitUntilExit() pending — the process hangs with the terminal captured.
    instance.unmount();
    throw error;
  }
}

/**
 * Run `propr setup` interactively. The setup engine is UI-agnostic: it streams
 * state through a reporter and collects decisions through prompt hooks. Here we
 * bridge both to an Ink view ({@link SetupApp}) — the step list updates live as
 * the engine emits state, and the engine's prompt hooks render confirm / input /
 * single-choice / multi-choice prompts the user drives with the keyboard.
 *
 * Resolves with the final {@link SetupRunResult} once the engine finishes (and
 * the view has painted its last frame). On Ctrl-C the view cancels any in-flight
 * prompt — which unwinds the engine so `runSetup` still resolves — and exits the
 * Ink session, so nothing is left running. Callers should use
 * `result.completed` to decide what to print afterwards.
 */
export async function renderSetupWizard(
  options: Omit<RunSetupOptions, "prompts" | "reporter"> = {}
): Promise<SetupRunResult> {
  const bridge = new SetupBridge();
  const instance = render(<SetupApp bridge={bridge} />, { exitOnCtrlC: false });

  const reporter: SetupReporter = {
    onState: (state) => bridge.emitState(state),
    onLog: (line) => bridge.emitLog(line),
  };

  // runSetup never throws for cancellation: a cancelled prompt rejects, the
  // engine catches it, settles the step, and returns its (incomplete) state.
  const result = await runSetup({ ...options, prompts: buildSetupPrompts(bridge), reporter });

  bridge.finish(result.state);
  await instance.waitUntilExit();
  return result;
}
