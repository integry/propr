/**
 * Minimal Fly Machines API client (https://api.machines.dev/v1) for
 * `propr deploy fly` when flyctl is not installed. Only the calls the deploy
 * needs: app, shared IPs, volume, secrets, Machine create/update and wait.
 *
 * The token is a user-provided Fly token (`fly tokens create org` or a deploy
 * token). Macaroon tokens already carry their `FlyV1 ` scheme; anything else is
 * sent as a Bearer token. The token is never logged or included in errors.
 */

export const FLY_MACHINES_API_URL = "https://api.machines.dev/v1";

export class FlyApiError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(`Fly Machines API ${method} ${path} failed with HTTP ${status}${body ? `: ${body.slice(0, 500)}` : ""}`);
    this.name = "FlyApiError";
  }
}

export interface FlyApiClientOptions {
  token: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface FlyVolume {
  id: string;
  name: string;
  region: string;
  size_gb: number;
  state?: string;
  attached_machine_id?: string | null;
}

export interface FlyMachine {
  id: string;
  name?: string;
  state: string;
  region: string;
  instance_id?: string;
  config?: { metadata?: Record<string, string>; mounts?: Array<{ volume?: string; path?: string }> };
}

export interface FlyIpAssignment {
  ip: string;
  shared?: boolean;
}

export function flyAuthorizationHeader(token: string): string {
  const trimmed = token.trim();
  if (!trimmed) throw new Error("Fly API token is empty");
  return /^FlyV1\s/.test(trimmed) ? trimmed : `Bearer ${trimmed}`;
}

export class FlyMachinesApi {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly authorization: string;

  constructor(options: FlyApiClientOptions) {
    this.baseUrl = (options.baseUrl ?? FLY_MACHINES_API_URL).replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.authorization = flyAuthorizationHeader(options.token);
  }

  private async request<T>(method: string, path: string, body?: unknown, allowStatus: number[] = []): Promise<{ status: number; data: T | undefined }> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: this.authorization,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok && !allowStatus.includes(response.status)) {
      throw new FlyApiError(method, path, response.status, text);
    }
    if (!response.ok || !text) return { status: response.status, data: undefined };
    try {
      return { status: response.status, data: JSON.parse(text) as T };
    } catch {
      throw new FlyApiError(method, path, response.status, "response was not JSON");
    }
  }

  private appPath(app: string, suffix = ""): string {
    return `/apps/${encodeURIComponent(app)}${suffix}`;
  }

  /** Returns true when the app exists, false on 404. */
  async appExists(app: string): Promise<boolean> {
    const { status } = await this.request("GET", this.appPath(app), undefined, [404]);
    return status !== 404;
  }

  async createApp(app: string, org: string): Promise<void> {
    // The documented request uses `app_name`; fly-go sends `name`. Send both.
    await this.request("POST", "/apps", { app_name: app, name: app, org_slug: org });
  }

  async listIpAssignments(app: string): Promise<FlyIpAssignment[]> {
    const { data } = await this.request<{ ips?: FlyIpAssignment[] }>("GET", this.appPath(app, "/ip_assignments"));
    return data?.ips ?? [];
  }

  /** Free shared IPv4 plus a dedicated IPv6, so <app>.fly.dev resolves. */
  async ensurePublicIps(app: string): Promise<string[]> {
    const existing = await this.listIpAssignments(app);
    const allocated: string[] = [];
    const hasV4 = existing.some((ip) => !ip.ip.includes(":"));
    const hasPublicV6 = existing.some((ip) => ip.ip.includes(":") && !ip.ip.startsWith("fdaa:"));
    if (!hasV4) {
      await this.request("POST", this.appPath(app, "/ip_assignments"), { type: "shared_v4" });
      allocated.push("shared IPv4");
    }
    if (!hasPublicV6) {
      await this.request("POST", this.appPath(app, "/ip_assignments"), { type: "v6" });
      allocated.push("IPv6");
    }
    return allocated;
  }

  async listVolumes(app: string): Promise<FlyVolume[]> {
    const { data } = await this.request<FlyVolume[]>("GET", this.appPath(app, "/volumes"));
    return data ?? [];
  }

  async createVolume(app: string, input: { name: string; region: string; sizeGb: number }): Promise<FlyVolume> {
    const { data } = await this.request<FlyVolume>("POST", this.appPath(app, "/volumes"), {
      name: input.name,
      region: input.region,
      size_gb: input.sizeGb,
      encrypted: true,
    });
    if (!data?.id) throw new Error("Fly did not return the created volume");
    return data;
  }

  /** Secret names already set on the app (values are never read back). */
  async listSecretNames(app: string): Promise<string[]> {
    const { data } = await this.request<{ secrets?: Array<{ name?: string }> }>("GET", this.appPath(app, "/secrets"));
    return (data?.secrets ?? []).map((secret) => secret.name ?? "").filter(Boolean);
  }

  async setSecrets(app: string, values: Record<string, string>): Promise<void> {
    if (Object.keys(values).length === 0) return;
    await this.request("POST", this.appPath(app, "/secrets"), { values });
  }

  async listMachines(app: string): Promise<FlyMachine[]> {
    const { data } = await this.request<FlyMachine[]>("GET", this.appPath(app, "/machines"));
    return data ?? [];
  }

  async createMachine(app: string, input: { name: string; region: string; config: unknown }): Promise<FlyMachine> {
    const { data } = await this.request<FlyMachine>("POST", this.appPath(app, "/machines"), input);
    if (!data?.id) throw new Error("Fly did not return the created Machine");
    return data;
  }

  async updateMachine(app: string, machineId: string, input: { region: string; config: unknown }): Promise<FlyMachine> {
    const { data } = await this.request<FlyMachine>("POST", this.appPath(app, `/machines/${encodeURIComponent(machineId)}`), input);
    if (!data?.id) throw new Error("Fly did not return the updated Machine");
    return data;
  }

  /**
   * Block until the Machine reaches `state`. Fly caps one wait at 60 s and
   * answers 408 when it expires, so keep waiting until `timeoutSeconds` (the
   * first boot pulls the app image, which can take a few minutes).
   */
  async waitForState(app: string, machine: FlyMachine, state: string, timeoutSeconds = 300): Promise<void> {
    const deadline = Date.now() + timeoutSeconds * 1000;
    const path = this.appPath(app, `/machines/${encodeURIComponent(machine.id)}/wait`);
    for (;;) {
      const remaining = Math.ceil((deadline - Date.now()) / 1000);
      const query = new URLSearchParams({ state, timeout: String(Math.min(60, Math.max(1, remaining))) });
      if (machine.instance_id) query.set("instance_id", machine.instance_id);
      const { status } = await this.request("GET", `${path}?${query.toString()}`, undefined, [408]);
      if (status !== 408) return;
      if (Date.now() >= deadline) {
        throw new Error(`Machine ${machine.id} did not reach state "${state}" within ${timeoutSeconds}s; check \`fly logs --app ${app}\``);
      }
    }
  }
}
