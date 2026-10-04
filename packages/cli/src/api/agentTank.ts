/**
 * Agent Tank API
 *
 * Agent Tank tracks LLM subscription usage. It is a backend setting rather than
 * a stack container — in `bundled` mode ProPR runs the Agent Tank CLI inside the
 * agent image, and in `external` mode it talks to an instance the operator runs
 * — so these helpers go through the running ProPR API
 * (`/api/config/agent-tank`).
 */

import { ApiClient, createApiClient } from "./index.js";
import {
  AGENT_TANK_LEGACY_BACKEND_MESSAGE,
  agentTankModeFromLegacyEnabled,
  buildAgentTankSettingsRequest,
  isAgentTankMode,
  supportsAgentTankModes,
  type AgentTankMode,
} from "@propr/shared";

export interface AgentTankSettings {
  mode: AgentTankMode;
  enabled: boolean;
  url?: string;
  /**
   * False when the backend predates integration modes and answered with only
   * `{ enabled, url }`. Such a backend cannot store `bundled` at all, so the
   * mode above is derived rather than reported.
   */
  supportsModes?: boolean;
}

/** Raw `GET` shape: a pre-mode backend omits `mode` entirely. */
interface AgentTankSettingsResponse {
  mode?: unknown;
  enabled?: unknown;
  url?: string;
}

const DEFAULT_AGENT_TANK_URL = "http://127.0.0.1:3456";

/** Fetch the current Agent Tank settings. */
export async function getAgentTank(client?: ApiClient): Promise<AgentTankSettings> {
  const apiClient = client ?? (await createApiClient());
  const response = await apiClient.get<AgentTankSettingsResponse>("/api/config/agent-tank");
  const raw = response.data;
  // Derive the mode when the backend does not report one, so `propr tank`
  // prints what an older backend is actually doing instead of `undefined`.
  const mode = isAgentTankMode(raw?.mode)
    ? raw.mode
    : agentTankModeFromLegacyEnabled(raw?.enabled);
  return {
    mode,
    enabled: mode !== "disabled",
    url: raw?.url,
    supportsModes: supportsAgentTankModes(raw),
  };
}

/** Set the Agent Tank integration mode, optionally setting the external URL. */
export async function setAgentTank(
  mode: AgentTankMode,
  url?: string,
  client?: ApiClient
): Promise<AgentTankSettings> {
  const apiClient = client ?? (await createApiClient());

  // Preserve the existing URL when the caller doesn't pass one, so switching to
  // bundled and back to external does not lose a hand-tuned endpoint. Bundled
  // always reads the current settings anyway - see the compatibility check.
  let resolvedUrl = url;
  let current: AgentTankSettings | undefined;
  if (!resolvedUrl || mode === "bundled") {
    current = await getAgentTank(apiClient);
    resolvedUrl = resolvedUrl || current.url || DEFAULT_AGENT_TANK_URL;
  }

  // A pre-mode backend reads only `{ enabled, url }`, so it would store this
  // bundled request as "external, at the saved URL" and still answer success.
  // `external` and `disabled` need no such guard: the request body carries the
  // derived `enabled` flag those backends act on.
  if (mode === "bundled" && current && !current.supportsModes) {
    throw new Error(AGENT_TANK_LEGACY_BACKEND_MESSAGE);
  }

  await apiClient.post("/api/config/agent-tank", {
    body: buildAgentTankSettingsRequest(mode, resolvedUrl),
  });
  return { mode, enabled: mode !== "disabled", url: resolvedUrl };
}
