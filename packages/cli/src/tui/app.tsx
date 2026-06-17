/**
 * ink entry — renders the live dashboard and resolves with the exit outcome
 * ("background" if the user left the stack running, "stopped" if they stopped it).
 */

import React from "react";
import { render } from "ink";
import { StartApp } from "./StartApp.js";
import { CheckApp, CheckHub, type RemediationMenuItem } from "./CheckApp.js";
import type { OrchestratorConfig, OrchestratorModule } from "../orchestrator/index.js";
import type { ConfigManager } from "../config/index.js";
import { runChecks, type ChecksOutcome, type RunChecksOptions } from "../commands/checkCommands.js";

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
  opts: { fix?: boolean; offerValidate?: boolean; getActions: (outcome: ChecksOutcome) => RemediationMenuItem[] }
): Promise<{ outcome: ChecksOutcome | undefined; selectedKey: string | undefined; validate: boolean }> {
  const hub = new CheckHub();
  let selectedKey: string | undefined;
  let validate = false;
  const instance = render(
    <CheckApp
      hub={hub}
      fix={Boolean(opts.fix)}
      getActions={opts.getActions}
      onSelect={(key) => { selectedKey = key; }}
      offerValidate={Boolean(opts.offerValidate)}
      onValidate={(yes) => { validate = yes; }}
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
  const outcome = await outcomePromise;
  if (engineError) throw engineError;
  return { outcome, selectedKey, validate };
}
