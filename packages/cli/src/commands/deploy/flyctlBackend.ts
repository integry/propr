/**
 * flyctl backend for `propr deploy fly`. Used when `flyctl` (or `fly`) is on
 * PATH: it reuses the operator's existing `fly auth login` session, and
 * `fly deploy` handles IP allocation and rolling the Machine.
 *
 * Every call goes through an injectable {@link FlyctlRunner} so tests can pin
 * the exact argv without a real flyctl. Secrets are passed on stdin
 * (`fly secrets import`), never on argv.
 */

import { spawnSync } from "node:child_process";
import { dirname } from "node:path";

export interface FlyctlRunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface FlyctlRunOptions {
  input?: string;
  /** Stream output to the terminal instead of capturing it (long-running deploys). */
  inherit?: boolean;
  /** Working directory for flyctl (defaults to the caller's). */
  cwd?: string;
}

export interface FlyctlMachine {
  id: string;
  config?: {
    metadata?: Record<string, string>;
    mounts?: Array<{ volume?: string; path?: string }>;
    volumes?: unknown;
    containers?: unknown;
  };
}

export type FlyctlRunner = (args: string[], options?: FlyctlRunOptions) => FlyctlRunResult;

export function createFlyctlRunner(bin: string, env: NodeJS.ProcessEnv = process.env): FlyctlRunner {
  return (args, options = {}) => {
    const result = spawnSync(bin, args, {
      env,
      cwd: options.cwd,
      input: options.input,
      encoding: "utf-8",
      stdio: options.inherit ? ["pipe", "inherit", "inherit"] : ["pipe", "pipe", "pipe"],
      maxBuffer: 16 * 1024 * 1024,
    });
    if (result.error) {
      return { status: null, stdout: "", stderr: result.error.message };
    }
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  };
}

/** First of `flyctl`, `fly` that answers `version`; undefined when neither is installed. */
export function detectFlyctl(
  probe: (bin: string) => boolean = (bin) => spawnSync(bin, ["version"], { stdio: "ignore" }).status === 0,
  candidates: readonly string[] = ["flyctl", "fly"],
): string | undefined {
  return candidates.find((bin) => probe(bin));
}

function check(result: FlyctlRunResult, what: string): FlyctlRunResult {
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new Error(`flyctl ${what} failed${detail ? `: ${detail.slice(0, 500)}` : ""}`);
  }
  return result;
}

function parseJsonArray(text: string, what: string): Array<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(text || "[]");
    return Array.isArray(parsed) ? (parsed as Array<Record<string, unknown>>) : [];
  } catch {
    throw new Error(`flyctl ${what} did not return JSON`);
  }
}

/** `NAME=VALUE` lines for `fly secrets import`; values must be single-line. */
export function renderSecretsImport(values: Record<string, string>): string {
  return Object.entries(values)
    .map(([name, value]) => {
      if (/[\r\n]/.test(value)) throw new Error(`secret ${name} must be a single line (base64-encode multi-line values)`);
      return `${name}=${value}`;
    })
    .join("\n");
}

export class FlyctlBackend {
  constructor(private readonly run: FlyctlRunner) {}

  appExists(app: string): boolean {
    return this.appOwner(app).exists;
  }

  /**
   * Whether the app exists and, when `apps list` says, the slug of the org
   * that owns it (`org` is undefined when flyctl does not report one).
   */
  appOwner(app: string): { exists: boolean; org?: string } {
    const result = check(this.run(["apps", "list", "--json"]), "apps list");
    const entry = parseJsonArray(result.stdout, "apps list").find((e) => (e.Name ?? e.name) === app);
    if (!entry) return { exists: false };
    const organization = (entry.Organization ?? entry.organization) as Record<string, unknown> | undefined;
    const slug = organization?.Slug ?? organization?.slug;
    return { exists: true, org: typeof slug === "string" && slug ? slug : undefined };
  }

  /** The token of the current `fly auth login` session, or undefined when flyctl cannot print one. */
  authToken(): string | undefined {
    const result = this.run(["auth", "token"]);
    if (result.status !== 0) return undefined;
    const lines = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    return lines[lines.length - 1] || undefined;
  }

  createApp(app: string, org: string): void {
    check(this.run(["apps", "create", app, "--org", org]), "apps create");
  }

  /**
   * `sizeGb` is NaN when flyctl does not report a size; `attachedMachineId`
   * is undefined when the volume is not attached to a Machine.
   */
  listVolumes(app: string): Array<{ id: string; name: string; region: string; sizeGb: number; attachedMachineId?: string }> {
    const result = check(this.run(["volumes", "list", "--app", app, "--json"]), "volumes list");
    return parseJsonArray(result.stdout, "volumes list").map((entry) => {
      const attached = entry.attached_machine_id ?? entry.AttachedMachine;
      return {
        id: String(entry.id ?? entry.ID ?? ""),
        name: String(entry.name ?? entry.Name ?? ""),
        region: String(entry.region ?? entry.Region ?? ""),
        sizeGb: Number(entry.size_gb ?? entry.SizeGb ?? entry.sizeGb ?? Number.NaN),
        ...(typeof attached === "string" && attached ? { attachedMachineId: attached } : {}),
      };
    });
  }

  /** The app's Machines with their live config, as `fly machine list --json` prints them. */
  listMachines(app: string): FlyctlMachine[] {
    const result = check(this.run(["machine", "list", "--app", app, "--json"]), "machine list");
    return parseJsonArray(result.stdout, "machine list")
      .map((entry) => ({
        id: String(entry.id ?? entry.ID ?? ""),
        config: (entry.config ?? entry.Config) as FlyctlMachine["config"],
      }))
      .filter((machine) => machine.id);
  }

  /** Destroy a Machine (stopping it first). Its volume is kept and becomes unattached. */
  destroyMachine(app: string, machineId: string): void {
    check(this.run(["machine", "destroy", machineId, "--app", app, "--force"]), "machine destroy");
  }

  /** Grow a volume to `sizeGb`; Fly volumes can only be extended, never shrunk. */
  extendVolume(app: string, volumeId: string, sizeGb: number): void {
    check(this.run(["volumes", "extend", volumeId, "--app", app, "--size", String(sizeGb), "--yes"]), "volumes extend");
  }

  createVolume(app: string, input: { name: string; region: string; sizeGb: number }): void {
    check(this.run([
      "volumes", "create", input.name, "--app", app, "--region", input.region,
      "--size", String(input.sizeGb), "--yes",
    ]), "volumes create");
  }

  listSecretNames(app: string): string[] {
    const result = check(this.run(["secrets", "list", "--app", app, "--json"]), "secrets list");
    return parseJsonArray(result.stdout, "secrets list")
      .map((entry) => String(entry.Name ?? entry.name ?? ""))
      .filter(Boolean);
  }

  /** Stage secrets without restarting anything; the following deploy applies them. */
  setSecrets(app: string, values: Record<string, string>): void {
    if (Object.keys(values).length === 0) return;
    check(this.run(["secrets", "import", "--app", app, "--stage"], { input: renderSecretsImport(values) }), "secrets import");
  }

  /**
   * Deploy the published image directly: no remote builder, no Docker-in-Docker.
   * flyctl resolves fly.toml's relative paths (machine_config) against its
   * working directory rather than the config file, so it runs from the
   * config's directory; the generated fly.toml also uses an absolute path.
   */
  deploy(input: { app: string; configPath: string; image: string; region: string }): void {
    check(this.run([
      "deploy", "--app", input.app, "--config", input.configPath, "--image", input.image,
      "--primary-region", input.region, "--ha=false", "--yes",
    ], { inherit: true, cwd: dirname(input.configPath) }), "deploy");
  }
}
