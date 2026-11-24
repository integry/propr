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

export interface FlyctlRunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface FlyctlRunOptions {
  input?: string;
  /** Stream output to the terminal instead of capturing it (long-running deploys). */
  inherit?: boolean;
}

export type FlyctlRunner = (args: string[], options?: FlyctlRunOptions) => FlyctlRunResult;

export function createFlyctlRunner(bin: string, env: NodeJS.ProcessEnv = process.env): FlyctlRunner {
  return (args, options = {}) => {
    const result = spawnSync(bin, args, {
      env,
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
    const result = check(this.run(["apps", "list", "--json"]), "apps list");
    return parseJsonArray(result.stdout, "apps list").some((entry) => (entry.Name ?? entry.name) === app);
  }

  createApp(app: string, org: string): void {
    check(this.run(["apps", "create", app, "--org", org]), "apps create");
  }

  /** `sizeGb` is NaN when flyctl does not report a size. */
  listVolumes(app: string): Array<{ id: string; name: string; region: string; sizeGb: number }> {
    const result = check(this.run(["volumes", "list", "--app", app, "--json"]), "volumes list");
    return parseJsonArray(result.stdout, "volumes list").map((entry) => ({
      id: String(entry.id ?? entry.ID ?? ""),
      name: String(entry.name ?? entry.Name ?? ""),
      region: String(entry.region ?? entry.Region ?? ""),
      sizeGb: Number(entry.size_gb ?? entry.SizeGb ?? entry.sizeGb ?? Number.NaN),
    }));
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

  /** Deploy the published image directly: no remote builder, no Docker-in-Docker. */
  deploy(input: { app: string; configPath: string; image: string; region: string }): void {
    check(this.run([
      "deploy", "--app", input.app, "--config", input.configPath, "--image", input.image,
      "--primary-region", input.region, "--ha=false", "--yes",
    ], { inherit: true }), "deploy");
  }
}
