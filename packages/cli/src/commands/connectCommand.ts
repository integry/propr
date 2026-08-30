import { Command } from "commander";
import {
  PROPR_CONNECT_DISCOVERY_MAX_BYTES,
  PROPR_CONNECT_DISCOVERY_SCHEMA_VERSION,
  canonicalProprProxyUrl,
  evaluateProprApiCompatibility,
  parseProprDesktopDiscovery,
  type ProprDesktopDiscovery,
} from "@propr/shared";
import { prepareConnectHostConfig } from "../orchestrator/index.js";
import type { OrchestratorConfig } from "../orchestrator/types.js";
import {
  ConnectRootError,
  PublicInstanceIdentityError,
  readSnapshotPublicInstanceIdentity,
  withOwnedConnectRootSnapshot,
} from "../connectIdentity.js";

export const CONNECT_STATUS_EXIT = {
  ready: 0,
  internalFailure: 1,
  notReady: 0,
  incompatible: 2,
  invalidConfig: 1,
  timeout: 0,
} as const;

export type ConnectStatusKind = keyof typeof CONNECT_STATUS_EXIT;
export type ConnectStatusReasonCode =
  | "NOT_CONFIGURED"
  | "TUNNEL_DISABLED"
  | "SIDECAR_NOT_RUNNING"
  | "API_UNREACHABLE"
  | "API_TIMEOUT"
  | "DISCOVERY_UNSUPPORTED"
  | "DISCOVERY_INVALID"
  | "DISCOVERY_TOO_LARGE"
  | "API_INCOMPATIBLE"
  | "IDENTITY_MISMATCH"
  | "ENDPOINT_MISMATCH"
  | "RESTART_REQUIRED"
  | "INVALID_ROOT"
  | "INVALID_ENDPOINT"
  | "IDENTITY_UNAVAILABLE"
  | "INTERNAL_FAILURE"
  | "ACL_DIAGNOSTIC_UNAVAILABLE";

export interface ConnectStatusDocument {
  schemaVersion: typeof PROPR_CONNECT_DISCOVERY_SCHEMA_VERSION;
  status: ConnectStatusKind;
  canonicalEndpoint: string | null;
  publicInstanceIdentity: string | null;
  configured: boolean;
  enabled: boolean;
  sidecarRunning: boolean;
  apiReady: boolean;
  restartRequired: boolean;
  compatibility: string | null;
  version: string | null;
  reasonCodes: ConnectStatusReasonCode[];
}

type DiscoveryProbeResult =
  | { kind: "ok"; discovery: ProprDesktopDiscovery }
  | { kind: "timeout" }
  | { kind: "unreachable" }
  | { kind: "unsupported" }
  | { kind: "invalid" }
  | { kind: "tooLarge" };

function baseDocument(
  status: ConnectStatusKind,
  overrides: Partial<ConnectStatusDocument> = {},
): ConnectStatusDocument {
  return {
    schemaVersion: PROPR_CONNECT_DISCOVERY_SCHEMA_VERSION,
    status,
    canonicalEndpoint: null,
    publicInstanceIdentity: null,
    configured: false,
    enabled: false,
    sidecarRunning: false,
    apiReady: false,
    restartRequired: false,
    compatibility: null,
    version: null,
    reasonCodes: [],
    ...overrides,
  };
}

function parseContentLength(response: Response): number | null {
  const raw = response.headers.get("content-length");
  if (raw === null) return null;
  if (!/^\d{1,10}$/.test(raw)) return Number.POSITIVE_INFINITY;
  return Number(raw);
}

function cancelResponseBody(response: Response): void {
  try {
    const cancellation = response.body?.cancel();
    if (cancellation) void cancellation.catch(() => undefined);
  } catch {
    // Cancellation is best-effort at the transport adapter boundary; the
    // owning AbortController is also aborted before probe return.
  }
}

export type BoundedBodyResult =
  | { kind: "ok"; body: string }
  | { kind: "tooLarge" }
  | { kind: "invalid" };

export async function readBoundedBody(response: Response, signal: AbortSignal): Promise<BoundedBodyResult> {
  const declaredLength = parseContentLength(response);
  if (declaredLength !== null && declaredLength > PROPR_CONNECT_DISCOVERY_MAX_BYTES) {
    cancelResponseBody(response);
    return { kind: "tooLarge" };
  }
  if (!response.body) return { kind: "ok", body: "" };

  if (signal.aborted) {
    cancelResponseBody(response);
    throw new Error("Connect discovery response was aborted");
  }
  const reader = response.body.getReader();
  let canceled = false;
  const abort = () => {
    if (canceled) return;
    canceled = true;
    try {
      void reader.cancel().catch(() => undefined);
    } catch {
      // The stream may already be closed or errored.
    }
  };
  // Check on both sides of listener installation. AbortSignal dispatch is
  // synchronous, so after the second check either this listener observed the
  // abort or it remains installed for the subsequent body read.
  if (signal.aborted) abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    if (signal.aborted) throw new Error("Connect discovery response was aborted");
    while (true) {
      const { done, value } = await reader.read();
      if (signal.aborted) throw new Error("Connect discovery response was aborted");
      if (done) break;
      if (!value) continue;
      length += value.byteLength;
      if (length > PROPR_CONNECT_DISCOVERY_MAX_BYTES) {
        abort();
        return { kind: "tooLarge" };
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return { kind: "ok", body: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
    } catch {
      cancelResponseBody(response);
      return { kind: "invalid" };
    }
  } finally {
    signal.removeEventListener("abort", abort);
    try {
      reader.releaseLock();
    } catch {
      // A transport may keep cancellation pending briefly; the listener is
      // already detached and cancellation remains owned by the reader.
    }
  }
}

async function performDiscoveryFetch(
  canonicalEndpoint: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<DiscoveryProbeResult> {
  try {
    const response = await fetchImpl(`${canonicalEndpoint}/api/desktop/discovery`, {
      signal,
      redirect: "manual",
      headers: { Accept: "application/json" },
    });
    if (signal.aborted) {
      cancelResponseBody(response);
      return { kind: "timeout" };
    }
    if (response.status === 404) {
      cancelResponseBody(response);
      return { kind: "unsupported" };
    }
    if (!response.ok) {
      cancelResponseBody(response);
      return { kind: "unreachable" };
    }
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/json") {
      cancelResponseBody(response);
      return { kind: "invalid" };
    }
    const bodyResult = await readBoundedBody(response, signal);
    if (bodyResult.kind !== "ok") return { kind: bodyResult.kind };
    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyResult.body);
    } catch {
      cancelResponseBody(response);
      return { kind: "invalid" };
    }
    const discovery = parseProprDesktopDiscovery(parsed);
    if (!discovery) cancelResponseBody(response);
    return discovery ? { kind: "ok", discovery } : { kind: "invalid" };
  } catch {
    return signal.aborted ? { kind: "timeout" } : { kind: "unreachable" };
  }
}

/** One bounded, redirect-free probe with a deadline that does not trust fetch to abort itself. */
export async function probeConnectDiscovery(
  canonicalEndpoint: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 5000,
): Promise<DiscoveryProbeResult> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<DiscoveryProbeResult>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ kind: "timeout" });
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      performDiscoveryFetch(canonicalEndpoint, fetchImpl, controller.signal),
      timeout,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
  }
}

export interface ResolveConnectStatusOptions {
  cfg: Pick<OrchestratorConfig, "uiPublicApiUrl" | "proprInstanceId" | "uiTunnelEnabled">;
  sidecarRunning: boolean;
  publicInstanceIdentity: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** Pure status state machine used by the CLI wiring and deterministic tests. */
export async function resolveConnectStatus({
  cfg,
  sidecarRunning,
  publicInstanceIdentity,
  fetchImpl = fetch,
  timeoutMs = 5000,
}: ResolveConnectStatusOptions): Promise<ConnectStatusDocument> {
  const configuredValue = cfg.uiPublicApiUrl;
  const canonicalEndpoint = canonicalProprProxyUrl(configuredValue) ?? null;
  const enabled = Boolean(cfg.uiTunnelEnabled);
  const common = {
    canonicalEndpoint,
    publicInstanceIdentity,
    configured: canonicalEndpoint !== null,
    enabled,
    sidecarRunning,
  };

  if ((configuredValue && !canonicalEndpoint) || (cfg.proprInstanceId && !canonicalEndpoint)) {
    return baseDocument("invalidConfig", { ...common, reasonCodes: ["INVALID_ENDPOINT"] });
  }

  const reasons: ConnectStatusReasonCode[] = [];
  if (!canonicalEndpoint) reasons.push("NOT_CONFIGURED");
  if (!enabled) reasons.push("TUNNEL_DISABLED");
  if (enabled && !sidecarRunning) reasons.push("SIDECAR_NOT_RUNNING");
  if (reasons.length > 0 || !canonicalEndpoint) {
    return baseDocument("notReady", { ...common, reasonCodes: reasons });
  }

  const probe = await probeConnectDiscovery(canonicalEndpoint, fetchImpl, timeoutMs);
  if (probe.kind === "timeout") {
    return baseDocument("timeout", { ...common, reasonCodes: ["API_TIMEOUT"] });
  }
  if (probe.kind === "unreachable") {
    return baseDocument("notReady", { ...common, reasonCodes: ["API_UNREACHABLE"] });
  }
  if (probe.kind === "unsupported") {
    return baseDocument("incompatible", { ...common, reasonCodes: ["DISCOVERY_UNSUPPORTED"] });
  }
  if (probe.kind === "invalid" || probe.kind === "tooLarge") {
    return baseDocument("incompatible", {
      ...common,
      reasonCodes: [probe.kind === "tooLarge" ? "DISCOVERY_TOO_LARGE" : "DISCOVERY_INVALID"],
    });
  }

  const compatibility = evaluateProprApiCompatibility(probe.discovery);
  const remoteMetadata = {
    compatibility: probe.discovery.apiCompatibility,
    version: probe.discovery.version,
  };
  if (!compatibility.compatible) {
    return baseDocument("incompatible", {
      ...common,
      ...remoteMetadata,
      reasonCodes: ["API_INCOMPATIBLE"],
    });
  }
  if (probe.discovery.publicInstanceIdentity !== publicInstanceIdentity) {
    return baseDocument("notReady", {
      ...common,
      ...remoteMetadata,
      reasonCodes: ["IDENTITY_MISMATCH"],
    });
  }
  if (probe.discovery.canonicalEndpoint !== canonicalEndpoint) {
    return baseDocument("notReady", {
      ...common,
      ...remoteMetadata,
      restartRequired: true,
      reasonCodes: ["ENDPOINT_MISMATCH", "RESTART_REQUIRED"],
    });
  }
  return baseDocument("ready", { ...common, ...remoteMetadata, apiReady: true });
}

export async function getLocalConnectStatus(root: string | undefined): Promise<ConnectStatusDocument> {
  try {
    const prepared = await prepareConnectHostConfig();
    const local = await withOwnedConnectRootSnapshot(root, async (snapshot) => {
      const cfg = prepared.resolveSnapshot(snapshot);
      // Status is discovery, not setup: never create/repair identity state or
      // invoke a privileged Windows protection operation from this path.
      const publicInstanceIdentity = await readSnapshotPublicInstanceIdentity(snapshot.identityDirectory);
      const sidecarInspection = prepared.inspectTunnel(cfg);
      return {
        cfg: {
          uiPublicApiUrl: cfg.uiPublicApiUrl,
          proprInstanceId: cfg.proprInstanceId,
          uiTunnelEnabled: cfg.uiTunnelEnabled,
        },
        publicInstanceIdentity,
        sidecarInspection,
        authorityDiagnostic: snapshot.authorityDiagnostic,
      };
    }, {
      parseEnvFile: prepared.parseEnvFile,
      // Node has no same-handle Windows DACL API. Read-only status reports this
      // diagnostic explicitly instead of executing a mutable packaged helper.
      allowUnavailableWindowsAclDiagnostic: process.platform === "win32",
    });
    const withAuthorityDiagnostic = (document: ConnectStatusDocument): ConnectStatusDocument => (
      local.authorityDiagnostic === "acl-unavailable"
        ? { ...document, reasonCodes: [...document.reasonCodes, "ACL_DIAGNOSTIC_UNAVAILABLE"] }
        : document
    );
    if (local.sidecarInspection.kind === "internalFailure") {
      return withAuthorityDiagnostic(baseDocument("internalFailure", { reasonCodes: ["INTERNAL_FAILURE"] }));
    }
    return withAuthorityDiagnostic(await resolveConnectStatus({
      cfg: local.cfg,
      sidecarRunning: local.sidecarInspection.running,
      publicInstanceIdentity: local.publicInstanceIdentity,
    }));
  } catch (error) {
    if (error instanceof ConnectRootError) {
      return baseDocument("invalidConfig", { reasonCodes: ["INVALID_ROOT"] });
    }
    if (error instanceof PublicInstanceIdentityError) {
      return baseDocument("invalidConfig", { reasonCodes: ["IDENTITY_UNAVAILABLE"] });
    }
    return baseDocument("internalFailure", { reasonCodes: ["INTERNAL_FAILURE"] });
  }
}

function printHumanStatus(document: ConnectStatusDocument): void {
  console.log(`Connect status: ${document.status}`);
  console.log(`  endpoint: ${document.canonicalEndpoint ?? "not configured"}`);
  console.log(`  enabled: ${document.enabled ? "yes" : "no"}`);
  console.log(`  sidecar: ${document.sidecarRunning ? "running" : "stopped"}`);
  console.log(`  API ready: ${document.apiReady ? "yes" : "no"}`);
  if (document.restartRequired) console.log("  restart required: yes");
  if (document.reasonCodes.length > 0) console.log(`  reasons: ${document.reasonCodes.join(", ")}`);
}

export function createConnectCommand(): Command {
  const command = new Command("connect").description("Discover the local ProPR Connect endpoint safely");
  command
    .command("status")
    .description("Print the versioned secret-free desktop discovery contract")
    .option("--root <dir>", "Explicit caller-owned stack root (required)")
    .option("-j, --json", "Emit one bounded JSON document on stdout")
    .action(async (options: { root?: string; json?: boolean }) => {
      const document = await getLocalConnectStatus(options.root);
      if (options.json) console.log(JSON.stringify(document));
      else printHumanStatus(document);
      if (document.status !== "ready") {
        console.error(`ProPR Connect discovery: ${document.status}.`);
      }
      process.exitCode = CONNECT_STATUS_EXIT[document.status];
    });
  return command;
}
