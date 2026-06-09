/**
 * ink entry — renders the live dashboard and resolves with the exit outcome
 * ("background" if the user left the stack running, "stopped" if they stopped it).
 */

import React from "react";
import { render } from "ink";
import { StartApp } from "./StartApp.js";
import type { OrchestratorConfig, OrchestratorModule } from "../orchestrator/index.js";

export interface DashboardProps {
  orch: OrchestratorModule;
  cfg: OrchestratorConfig;
}

export async function renderDashboard(props: DashboardProps): Promise<"background" | "stopped"> {
  const result: { outcome: "background" | "stopped" } = { outcome: "background" };
  const instance = render(
    <StartApp orch={props.orch} cfg={props.cfg} onResult={(o) => { result.outcome = o; }} />
  );
  await instance.waitUntilExit();
  return result.outcome;
}
