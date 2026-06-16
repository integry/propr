/**
 * ink entry — renders the live dashboard and resolves with the exit outcome
 * ("background" if the user left the stack running, "stopped" if they stopped it).
 */

import React from "react";
import { render } from "ink";
import { StartApp } from "./StartApp.js";
import { CheckApp } from "./CheckApp.js";
import type { OrchestratorConfig, OrchestratorModule } from "../orchestrator/index.js";
import type { ConfigManager } from "../config/index.js";
import type { ChecksOutcome } from "../commands/checkCommands.js";

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

export async function renderCheck(outcome: ChecksOutcome, opts: { showRemediationHint?: boolean } = {}): Promise<void> {
  const instance = render(
    <CheckApp outcome={outcome} showRemediationHint={opts.showRemediationHint} />,
    { exitOnCtrlC: false },
  );
  await instance.waitUntilExit();
}
