/**
 * Type definitions for the shared stack orchestrator
 * (docker/launcher/orchestrator.mjs).
 *
 * The orchestrator core is a dependency-free `.mjs` module shared with the
 * production launcher image. The CLI imports it at runtime via `loadOrchestrator`
 * (see ./index.ts) and types it with the `OrchestratorModule` interface below.
 * Keep this in sync with orchestrator.mjs's exports.
 */

import type { ChildProcess } from "node:child_process";

/** A resolved, frozen stack configuration. */
export interface OrchestratorConfig {
  readonly stack: string;
  readonly network: string;
  readonly envFileLocal: string;
  readonly envFileHost?: string;
  readonly validateHostPaths: boolean;
  readonly hostData?: string;
  readonly hostLogs?: string;
  readonly hostRepos?: string;
  readonly apiPort: string;
  readonly uiPort: string;
  readonly docsPort: string;
  readonly redisExternalPort: string;
  readonly docsEnabled: boolean;
  readonly hostClaudeDir?: string;
  readonly hostCodexDir?: string;
  readonly hostAntigravityDir?: string;
  readonly hostOpencodeLegacyDir?: string;
  readonly hostOpencodeXdgDir?: string;
  readonly hostOpencodeDataDir?: string;
  readonly hostVibeDir?: string;
  readonly vibePromptCacheDir: string;
  readonly hostVibePromptCacheDir?: string;
  readonly hostGhPrivateKey?: string;
  readonly mistralApiKey?: string;
  readonly vibeConfigPath?: string;
  readonly manifest: { version: string; images: Record<string, string> } & Record<string, unknown>;
  readonly images: Record<string, string>;
  readonly manifestPath: string;
}

/** State of a single service container, derived from `docker ps`. */
export interface ServiceState {
  name: string;
  service: string;
  exists: boolean;
  running: boolean;
  state: string;
  status: string;
  ports: string;
}

/** Full-stack status snapshot. */
export interface StackStatus {
  stack: string;
  network: string;
  running: boolean;
  services: ServiceState[];
}

/** Result of validating host paths / vibe settings. */
export interface ValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export type ImageFreshnessResult =
  | { status: "missing"; tag: string }
  | { status: "current"; tag: string; localDigests: string[]; remoteDigest: string }
  | { status: "stale"; tag: string; localDigests: string[]; remoteDigest: string }
  | { status: "unknown"; tag: string; localDigests?: string[]; error: string };

export interface ResolveHostConfigOptions {
  rootDir?: string;
  env?: NodeJS.ProcessEnv;
  manifestPath?: string;
  cliOverrides?: Record<string, unknown>;
}

export interface OnLogOption {
  onLog?: (line: string) => void;
  pull?: boolean;
}

/** Public surface of orchestrator.mjs consumed by the CLI. */
export interface OrchestratorModule {
  resolveConfig(env?: NodeJS.ProcessEnv, overrides?: Partial<OrchestratorConfig>): OrchestratorConfig;
  resolveHostConfig(opts?: ResolveHostConfigOptions): OrchestratorConfig;
  readEnvFile(envFilePath: string): Record<string, string>;
  validateEnv(cfg: OrchestratorConfig): ValidationResult;
  validateDockerBindPath(name: string, value?: string, opts?: { containerPath?: boolean }): string | null;

  dockerAvailable(): boolean;
  inspectImageFreshness(tag: string): ImageFreshnessResult;
  ensureNetwork(cfg: OrchestratorConfig, onLog?: (line: string) => void): void;
  ensureServiceImage(cfg: OrchestratorConfig, service: string, onLog?: (line: string) => void): void;
  pullImages(
    cfg: OrchestratorConfig,
    opts?: { onLog?: (line: string) => void; env?: NodeJS.ProcessEnv }
  ): { failedAgentImages: string[]; strictAgentPull: boolean };

  readonly SERVICES: readonly string[];
  readonly CORE_SERVICES: readonly string[];
  readonly TOGGLE_SERVICES: readonly string[];

  isStackRunning(cfg: OrchestratorConfig): boolean;

  startService(cfg: OrchestratorConfig, service: string, opts?: OnLogOption): ServiceState | undefined;
  stopService(cfg: OrchestratorConfig, service: string, opts?: { remove?: boolean; onLog?: (line: string) => void }): void;
  startStack(
    cfg: OrchestratorConfig,
    opts?: { ui?: boolean; docs?: boolean; onLog?: (line: string) => void }
  ): StackStatus;
  stopStack(
    cfg: OrchestratorConfig,
    opts?: { remove?: boolean; removeNetwork?: boolean; onLog?: (line: string) => void }
  ): { failed: string[] };

  getStackStatus(cfg: OrchestratorConfig): StackStatus;
  getServiceState(cfg: OrchestratorConfig, service: string): ServiceState | undefined;
  getServiceLogs(
    cfg: OrchestratorConfig,
    service: string,
    opts?: { follow?: boolean; tail?: number | string; stdio?: unknown }
  ): ChildProcess;

  containerExists(cfg: OrchestratorConfig, name: string): boolean;
  docker(args: string[], opts?: { capture?: boolean }): { status: number | null; stdout: string; stderr: string };
}
