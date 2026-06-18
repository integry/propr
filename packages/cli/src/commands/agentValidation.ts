/**
 * Live agent validation for `propr check` (opt-in, see --validate-agents).
 *
 * Per agent, three checks:
 *   • Version — compare the agent CLI version on the host vs inside the image
 *               (free, no LLM call). Images are usually newer; a mismatch can
 *               explain host-vs-image behavior differences.
 *   • Host    — run the agent's CLI on the host with host credentials (billable).
 *   • Image   — run the agent's Docker image with the credential directory
 *               mounted, mirroring the worker (billable).
 *
 * Comparing host vs image pinpoints failures: host OK + image FAIL ⇒ a
 * credential mount / container config problem rather than a bad credential.
 *
 * All checks run concurrently via async spawn. Image invocations mirror
 * @propr/core's agent buildDockerArgs / analyze(); they are best-effort
 * reconstructions — verify against real images on the host.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { OrchestratorConfig, OrchestratorModule } from "../orchestrator/index.js";
import type { CheckResult, CheckStatus } from "./checkCommands.js";

const VALIDATION_PROMPT = "Respond in 3 words: which model are you?";
const VALIDATION_TIMEOUT_MS = 120_000;
const VERSION_TIMEOUT_MS = 30_000;
const WORKSPACE = "/home/node/workspace";
const PROMPT_FILE = "/home/node/propr-prompt.txt";

// Treated as failure even when the process exits 0 (e.g. an agent that prints
// "Authentication required …" and exits cleanly). This intentionally scans the
// whole response; the validation prompt is constrained enough that accidental
// mentions of words like "quota" should be rare.
const FAILURE_MARKERS =
  /authentication required|please (?:visit|log ?in|sign ?in|authenticate)|not (?:logged ?in|authenticated|signed ?in)|unauthorized|\b401\b|\b403\b|invalid (?:api ?key|credentials|token)|(?:missing|no) api key|api key (?:not|is missing|required)|login required|permission denied|errno 13|command not found|must provide a (?:message|command)|quota|rate limit/i;

// Container entrypoint / setup chatter to drop from the captured response.
const NOISE_MARKERS =
  /skipping firewall|gh_token|github token|safe\.directory|using legacy|config(?:uration)? (?:directory )?(?:available|not|mounted|found)|ownership|^warning:|operations may fail|contents of|^total \d|^[-d][rwx-]{9}|setting up|executing command|wrapper|operational comment|filtering/i;

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;

interface ExecResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: NodeJS.ErrnoException;
}

/** Async exec with timeout + optional stdin; never rejects. */
function execAsync(
  cmd: string,
  args: string[],
  opts: { input?: string; cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs: number }
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (res: ExecResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(res);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ status: null, stdout, stderr, error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }) });
    }, opts.timeoutMs);
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("error", (error) => finish({ status: null, stdout, stderr, error }));
    child.on("close", (code) => finish({ status: code, stdout, stderr }));
    child.stdin.on("error", () => { /* ignore EPIPE if the child never reads stdin */ });
    if (opts.input != null) child.stdin.write(opts.input);
    child.stdin.end();
  });
}

function responseSummary(stdout: string, stderr: string): string {
  const meaningful = (text: string): string[] =>
    text
      .replace(ANSI_RE, "")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !NOISE_MARKERS.test(l));
  const lines = meaningful(stdout);
  const last = lines.length ? lines[lines.length - 1] : meaningful(stderr).pop();
  // Strip opencode's TUI status prefix (e.g. "> build · <model>") so the reply
  // reads like the others.
  return (last ?? "")
    .replace(/^>\s*\w+\s*[·•∙]\s*/u, "")
    .replace(/^>\s*/u, "")
    .trim();
}

function truncateDetail(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

function shellArg(arg: string): string {
  return /^[A-Za-z0-9_./:=@+-]+$/.test(arg) ? arg : `"${arg.replace(/["\\$`]/g, "\\$&")}"`;
}

function hostDebugCommand(d: AgentValidationDescriptor): string {
  if (!d.hostBin || !d.hostInvocation) return d.type;
  const { args } = d.hostInvocation({ prompt: "test", promptFileHost: "test" });
  return [d.hostBin, ...args].map(shellArg).join(" ");
}

/** Classify a finished run as ok/fail with a concise human detail. */
function evaluateRun(run: ExecResult): { ok: boolean; detail: string } {
  if (run.error?.code === "ETIMEDOUT") {
    return { ok: false, detail: `timed out after ${VALIDATION_TIMEOUT_MS / 1000}s` };
  }
  if (run.status !== 0) {
    const reason = (run.stderr || run.stdout || run.error?.message || "failed")
      .replace(ANSI_RE, "")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .pop();
    return { ok: false, detail: `exit ${run.status ?? "?"}: ${truncateDetail(reason || "failed", 160)}` };
  }
  const combined = `${run.stdout}\n${run.stderr}`;
  if (FAILURE_MARKERS.test(combined)) {
    const line = combined
      .replace(ANSI_RE, "")
      .split("\n")
      .map((l) => l.trim())
      .find((l) => FAILURE_MARKERS.test(l));
    return { ok: false, detail: truncateDetail(line || "authentication/availability error", 160) };
  }
  const response = responseSummary(run.stdout, run.stderr);
  return { ok: true, detail: response ? truncateDetail(response, 200) : "(responded, no text captured)" };
}

function parseVersion(text: string): string | undefined {
  const match = text.replace(ANSI_RE, "").match(/\b(\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.]+)?)\b/);
  return match?.[1];
}

/** Numeric-segment compare; returns sign of (a - b). */
function compareVersions(a: string, b: string): number {
  const pa = a.split(/[-.]/).map((n) => parseInt(n, 10) || 0);
  const pb = b.split(/[-.]/).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

interface ImageContext {
  image: string;
  hostDir: string;
  workspaceDir: string;
  promptFileHost: string;
  cfg: OrchestratorConfig;
}

interface AgentValidationDescriptor {
  type: string;
  imageKey: string;
  hostDirKey: keyof OrchestratorConfig;
  envKey: string;
  defaultHostDir: string;
  /** Host CLI binary name, or undefined when no host invocation is known. */
  hostBin?: string;
  hostInvocation?: (ctx: { prompt: string; promptFileHost: string }) => { args: string[]; stdin?: string };
  imageInvocation: (ctx: ImageContext) => { args: string[]; stdin?: string };
  /** Args (after the image) that print the CLI version inside the container. */
  versionArgs: string[];
  /** Where the host credential dir mounts inside the container. */
  containerConfigPath: string;
  /** Interactive login command (after the image), or undefined if none exists. */
  loginArgs?: string[];
  /** Extra docker args (env / mounts) the login needs beyond the credential mount. */
  loginExtraArgs?: (cfg: OrchestratorConfig) => string[];
}

/** Shared `docker run` prefix (ends with the image). */
function baseArgs(
  image: string,
  hostDir: string,
  containerConfigPath: string,
  workspaceDir: string,
  opts: { env?: string[]; extra?: string[]; configMode?: "ro" | "rw" } = {}
): string[] {
  return [
    "run", "--rm", "-i",
    "--security-opt", "no-new-privileges",
    "--cap-add", "CHOWN",
    "--network", "bridge",
    // Start as root so the image entrypoints can chown the mounts and drop to
    // the node user — matching how @propr/core actually runs these images.
    // Running as the host user breaks sudo/chown/mkdir inside the containers.
    "--user", "0:0",
    "-v", `${workspaceDir}:${WORKSPACE}:rw`,
    "-v", `${hostDir}:${containerConfigPath}:${opts.configMode ?? "rw"}`,
    "-e", "GH_TOKEN",
    ...(opts.env ?? []),
    ...(opts.extra ?? []),
    "-w", WORKSPACE,
    image,
  ];
}

const home = homedir();

const DESCRIPTORS: AgentValidationDescriptor[] = [
  {
    type: "claude",
    imageKey: "agent-claude",
    hostDirKey: "hostClaudeDir",
    envKey: "HOST_CLAUDE_DIR",
    defaultHostDir: join(home, ".claude"),
    hostBin: "claude",
    hostInvocation: ({ prompt }) => ({ args: ["-p", prompt, "--output-format", "text"] }),
    imageInvocation: ({ image, hostDir, workspaceDir }) => ({
      args: [
        ...baseArgs(image, hostDir, "/home/node/.claude", workspaceDir),
        "claude", "-p", "-", "--output-format", "text", "--dangerously-skip-permissions",
      ],
      stdin: VALIDATION_PROMPT,
    }),
    versionArgs: ["claude", "--version"],
    containerConfigPath: "/home/node/.claude",
    loginArgs: ["claude", "login"],
  },
  {
    type: "codex",
    imageKey: "agent-codex",
    hostDirKey: "hostCodexDir",
    envKey: "HOST_CODEX_DIR",
    defaultHostDir: join(home, ".codex"),
    hostBin: "codex",
    hostInvocation: ({ prompt }) => ({ args: ["exec", "--skip-git-repo-check", prompt] }),
    imageInvocation: ({ image, hostDir, workspaceDir }) => ({
      args: [
        ...baseArgs(image, hostDir, "/home/node/.codex", workspaceDir, {
          extra: ["--security-opt", "seccomp=unconfined", "--security-opt", "apparmor=unconfined"],
        }),
        "codex", "exec", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check", "--cd", WORKSPACE, "-",
      ],
      stdin: VALIDATION_PROMPT,
    }),
    versionArgs: ["codex", "--version"],
    containerConfigPath: "/home/node/.codex",
    loginArgs: ["codex", "login"],
  },
  {
    type: "antigravity",
    imageKey: "agent-antigravity",
    hostDirKey: "hostAntigravityDir",
    envKey: "HOST_ANTIGRAVITY_DIR",
    defaultHostDir: join(home, ".gemini"),
    hostBin: "agy",
    hostInvocation: ({ prompt }) => ({ args: ["-p", prompt] }),
    imageInvocation: ({ image, hostDir, workspaceDir }) => ({
      args: [
        ...baseArgs(image, hostDir, "/home/node/.gemini", workspaceDir, {
          env: ["-e", "ANTIGRAVITY_CLI=1", "-e", "ANTIGRAVITY_CLI_TRUST_WORKSPACE=true"],
        }),
        "/bin/bash", "-lc", 'set -e\nexec agy --dangerously-skip-permissions --print - "$@"', "propr-antigravity",
      ],
      stdin: VALIDATION_PROMPT,
    }),
    versionArgs: ["agy", "--version"],
    containerConfigPath: "/home/node/.gemini",
    // `agy` (installed via the antigravity script, not an npm global) isn't on
    // sudo's PATH when the entrypoint drops to the node user, so run it through a
    // login shell — matching the validation invocation.
    loginArgs: ["/bin/bash", "-lc", "exec agy login"],
    loginExtraArgs: () => ["-e", "ANTIGRAVITY_CLI=1", "-e", "ANTIGRAVITY_CLI_TRUST_WORKSPACE=true"],
  },
  {
    type: "opencode",
    imageKey: "agent-opencode",
    hostDirKey: "hostOpencodeXdgDir",
    envKey: "HOST_OPENCODE_XDG_DIR",
    defaultHostDir: join(home, ".config", "opencode"),
    hostBin: "opencode",
    hostInvocation: ({ prompt }) => ({ args: ["run", prompt] }),
    imageInvocation: ({ image, hostDir, workspaceDir, cfg }) => {
      const opencodeDataDir = resolveOpenCodeDataDir(hostDir, cfg);
      const extra = opencodeDataDir
        ? ["-v", `${opencodeDataDir}:/home/node/.local/share/opencode:rw`, "-e", "XDG_DATA_HOME=/home/node/.local/share"]
        : [];
      return {
        args: [
          ...baseArgs(image, hostDir, "/home/node/.config/opencode", workspaceDir, { extra }),
          "opencode", "run", VALIDATION_PROMPT,
        ],
      };
    },
    versionArgs: ["opencode", "--version"],
    containerConfigPath: "/home/node/.config/opencode",
    loginArgs: ["opencode", "auth", "login"],
    loginExtraArgs: (cfg) =>
      cfg.hostOpencodeDataDir ? ["-v", `${cfg.hostOpencodeDataDir}:/home/node/.local/share/opencode:rw`] : [],
  },
  {
    type: "vibe",
    imageKey: "agent-vibe",
    hostDirKey: "hostVibeDir",
    envKey: "HOST_VIBE_DIR",
    defaultHostDir: join(home, ".vibe"),
    hostBin: "vibe",
    // Host vibe (newer CLI) uses -p; the image's vibe build uses --prompt-file.
    hostInvocation: ({ prompt }) => ({ args: ["-p", prompt] }),
    imageInvocation: ({ image, hostDir, workspaceDir, promptFileHost, cfg }) => ({
      args: [
        ...baseArgs(image, hostDir, "/home/node/.vibe", workspaceDir, {
          configMode: "ro",
          env: [
            ...(cfg.mistralApiKey ? ["-e", "MISTRAL_API_KEY"] : []),
            "-e", "VIBE_SOURCE_HOME=/home/node/.vibe",
            "-e", "HOME=/tmp/propr-vibe-home",
            "-e", "VIBE_RUNTIME_HOME=/tmp/propr-vibe-home",
            "-e", "XDG_CACHE_HOME=/tmp/propr-vibe-cache",
            "-e", "XDG_CONFIG_HOME=/tmp/propr-vibe-config",
            "-e", "XDG_DATA_HOME=/tmp/propr-vibe-data",
            "-e", "XDG_STATE_HOME=/tmp/propr-vibe-state",
            "-e", "VIBE_READ_ONLY_CONFIG=1",
          ],
          extra: ["-v", `${promptFileHost}:${PROMPT_FILE}:ro`],
        }),
        "--prompt-file", PROMPT_FILE,
      ],
    }),
    versionArgs: ["--version"],
    containerConfigPath: "/home/node/.vibe",
    // Vibe has no interactive login flow here — it uses MISTRAL_API_KEY or a
    // pre-populated ~/.vibe — so loginArgs is intentionally omitted.
  },
];

function imagePresent(orch: OrchestratorModule, tag: string): boolean {
  return orch.docker(["images", "-q", tag], { capture: true }).stdout.trim().length > 0;
}

function commandExists(bin: string): boolean {
  return spawnSync("which", [bin], { encoding: "utf-8" }).status === 0;
}

function validateBindPath(name: string, value?: string): string | null {
  if (!value || !isAbsolute(value) || value.includes("~") || /[\0\r\n]/.test(value)) {
    return `${name} must be an absolute path without '~' or control characters (requires Linux host paths)`;
  }
  if (value.includes(":")) {
    return `${name} cannot contain ':' because it is used in a Docker bind mount (requires Linux — Windows-style paths like C:\\... are not supported)`;
  }
  return null;
}

function inferOpenCodeDataDir(configDir: string): string | undefined {
  const normalized = configDir.replace(/\/+$/, "");
  if (!normalized.endsWith("/.config/opencode")) return undefined;
  return `${normalized.slice(0, -"/.config/opencode".length)}/.local/share/opencode`;
}

function resolveOpenCodeDataDir(configDir: string, cfg: OrchestratorConfig): string | undefined {
  if (cfg.hostOpencodeDataDir) return cfg.hostOpencodeDataDir;
  const inferred = inferOpenCodeDataDir(configDir);
  return inferred && existsSync(inferred) ? inferred : undefined;
}

export interface AgentCell {
  status: CheckStatus;
  detail: string;
  fix?: string;
}

/** Streamed per-cell result, emitted as each check resolves. */
export type AgentCellUpdate =
  | { field: "version"; hostVersion?: string; imageVersion?: string; drift?: "older" | "newer" }
  | { field: "host"; cell: AgentCell }
  | { field: "image"; cell: AgentCell };

export interface ValidateAgentsOptions {
  /** Restrict validation to these agent types (defaults to all). */
  agents?: string[];
  /** Progress callback fired once before the parallel run (plain renderer). */
  onProgress?: (message: string) => void;
  /** Fired as each agent cell (version/host/image) resolves, for live rendering. */
  onUpdate?: (agent: string, update: AgentCellUpdate) => void;
}

/** The agent types that would be validated for the given filter (for seeding a live view). */
export function agentTypesFor(filter?: string[]): string[] {
  const normalized = normalizeAgentFilter(filter);
  const selected = normalized.length ? DESCRIPTORS.filter((d) => normalized.includes(d.type)) : DESCRIPTORS;
  return selected.map((d) => d.type);
}

function normalizeAgentFilter(filter?: string[]): string[] {
  return Array.from(new Set((filter ?? []).map((agent) => agent.trim().toLowerCase()).filter(Boolean)));
}

export function validateAgentFilter(filter?: string[]): { agents: string[]; unknown: string[] } {
  const known = new Set(DESCRIPTORS.map((d) => d.type));
  const agents = normalizeAgentFilter(filter);
  return { agents, unknown: agents.filter((agent) => !known.has(agent)) };
}

export function validAgentTypes(): string[] {
  return DESCRIPTORS.map((d) => d.type);
}

export interface AgentValidationRow {
  type: string;
  hostVersion?: string;
  imageVersion?: string;
  drift?: "older" | "newer"; // image relative to host (only when both known and differ)
  host?: AgentCell; // undefined when the agent has no known host invocation
  image: AgentCell;
}

async function versionInfo(
  d: AgentValidationDescriptor,
  image: string | undefined,
  orch: OrchestratorModule
): Promise<{ host?: string; image?: string; drift?: "older" | "newer" }> {
  const hostPromise = d.hostBin && commandExists(d.hostBin)
    ? execAsync(d.hostBin, ["--version"], { timeoutMs: VERSION_TIMEOUT_MS }).then((r) => parseVersion(`${r.stdout}\n${r.stderr}`))
    : Promise.resolve(undefined);
  const imagePromise = image && imagePresent(orch, image)
    ? execAsync("docker", ["run", "--rm", "--network=none", image, ...d.versionArgs], { timeoutMs: VERSION_TIMEOUT_MS }).then((r) => parseVersion(`${r.stdout}\n${r.stderr}`))
    : Promise.resolve(undefined);
  const [host, img] = await Promise.all([hostPromise, imagePromise]);
  const drift = host && img && host !== img ? (compareVersions(img, host) < 0 ? "older" : "newer") : undefined;
  return { host, image: img, drift };
}

function versionText(row: AgentValidationRow): string {
  const parts: string[] = [];
  if (row.hostVersion) parts.push(`host ${row.hostVersion}`);
  if (row.imageVersion) parts.push(`image ${row.imageVersion}`);
  if (parts.length === 0) return "version not detected";
  return `${parts.join(" / ")}${row.drift ? ` (image ${row.drift})` : ""}`;
}

/** Flatten structured rows into CheckResults (for --json and exit-code logic). */
export function agentRowsToChecks(rows: AgentValidationRow[]): CheckResult[] {
  const out: CheckResult[] = [];
  for (const row of rows) {
    const versionDetected = Boolean(row.hostVersion || row.imageVersion);
    out.push({ name: `Version: ${row.type}`, status: versionDetected ? "ok" : "warn", detail: versionText(row), group: "Agents" });
    if (row.host) out.push({ name: `Host: ${row.type}`, status: row.host.status, detail: row.host.detail, group: "Agents", ...(row.host.fix ? { fix: row.host.fix } : {}) });
    out.push({ name: `Image: ${row.type}`, status: row.image.status, detail: row.image.detail, group: "Agents", ...(row.image.fix ? { fix: row.image.fix } : {}) });
  }
  return out;
}

/**
 * Validate each present agent — version (host vs image), host CLI call, image
 * call — all concurrently. Returns one structured row per agent.
 */
export async function validateAgents(
  orch: OrchestratorModule,
  cfg: OrchestratorConfig,
  options: ValidateAgentsOptions = {}
): Promise<AgentValidationRow[]> {
  const { agents, unknown } = validateAgentFilter(options.agents);
  if (unknown.length > 0) {
    throw new Error(`unknown agent type${unknown.length === 1 ? "" : "s"} '${unknown.join(", ")}'. Valid agents: ${validAgentTypes().join(", ")}`);
  }
  const selected = agents.length
    ? DESCRIPTORS.filter((d) => agents.includes(d.type))
    : DESCRIPTORS;

  const tmp = mkdtempSync(join(tmpdir(), "propr-validate-"));
  const workspaceDir = join(tmp, "workspace");
  mkdirSync(workspaceDir, { recursive: true });
  const promptFileHost = join(tmp, "prompt.txt");
  writeFileSync(promptFileHost, `${VALIDATION_PROMPT}\n`);

  const runHost = async (d: AgentValidationDescriptor): Promise<AgentCell | undefined> => {
    if (!d.hostInvocation || !d.hostBin) return undefined;
    if (!commandExists(d.hostBin)) {
      return { status: "warn", detail: `${d.hostBin} not installed on host — skipped` };
    }
    const { args, stdin } = d.hostInvocation({ prompt: VALIDATION_PROMPT, promptFileHost });
    const run = await execAsync(d.hostBin, args, { input: stdin, cwd: workspaceDir, timeoutMs: VALIDATION_TIMEOUT_MS });
    const ev = evaluateRun(run);
    return { status: ev.ok ? "ok" : "fail", detail: ev.detail, ...(ev.ok ? {} : { fix: `Run \`${hostDebugCommand(d)}\` on the host to debug ${d.type} auth.` }) };
  };

  const runImage = async (d: AgentValidationDescriptor, image: string | undefined, hostDir: string | undefined): Promise<AgentCell> => {
    if (!image || !imagePresent(orch, image)) {
      return { status: "warn", detail: `image ${image ?? d.imageKey} not present — skipped` };
    }
    if (!hostDir) {
      return {
        status: "warn",
        detail: `${d.envKey} is not set — image validation skipped because the stack will not mount ${d.defaultHostDir}`,
        fix: `Set ${d.envKey} in .env or run \`propr check --fix\` to add a detected credential directory.`,
      };
    }
    const invalidHostDir = validateBindPath(d.envKey, hostDir);
    if (invalidHostDir) {
      return { status: "warn", detail: `${invalidHostDir} — image validation skipped` };
    }
    if (!existsSync(hostDir)) {
      return { status: "warn", detail: `credentials dir ${hostDir} not found — skipped` };
    }
    if (d.type === "opencode" && !resolveOpenCodeDataDir(hostDir, cfg)) {
      return {
        status: "warn",
        detail: `OpenCode config is mounted but auth data dir was not found for ${hostDir}`,
        fix: "Set HOST_OPENCODE_DATA_DIR to the host OpenCode data path (usually ~/.local/share/opencode).",
      };
    }
    const { args, stdin } = d.imageInvocation({ image, hostDir, workspaceDir, promptFileHost, cfg });
    const run = await execAsync("docker", args, {
      input: stdin,
      env: d.type === "vibe" && cfg.mistralApiKey ? { ...process.env, MISTRAL_API_KEY: cfg.mistralApiKey } : undefined,
      timeoutMs: VALIDATION_TIMEOUT_MS,
    });
    const ev = evaluateRun(run);
    const loginHint = d.loginArgs ? ` Re-authenticate with: propr agent login ${d.type}.` : "";
    return {
      status: ev.ok ? "ok" : "fail",
      detail: ev.detail,
      ...(ev.ok ? {} : { fix: `Check ${d.type} auth/mounts (creds: ${hostDir}).${loginHint} If "Host: ${d.type}" passed but this failed, it's a credential mount/config issue.` }),
    };
  };

  try {
    options.onProgress?.(`running checks for ${selected.length} agents in parallel…`);
    return await Promise.all(
      selected.map(async (d) => {
        const image = cfg.images[d.imageKey];
        let hostDir = cfg[d.hostDirKey] as string | undefined;
        if (d.type === "vibe" && !hostDir && cfg.mistralApiKey) {
          hostDir = join(tmp, "vibe-config");
          mkdirSync(hostDir, { recursive: true, mode: 0o700 });
        }
        // Emit each cell as it resolves so a live view can fill the table in.
        const versionP = versionInfo(d, image, orch).then((v) => {
          options.onUpdate?.(d.type, { field: "version", hostVersion: v.host, imageVersion: v.image, drift: v.drift });
          return v;
        });
        const hostP = runHost(d).then((h) => {
          options.onUpdate?.(d.type, { field: "host", cell: h ?? { status: "warn", detail: "no host CLI invocation" } });
          return h;
        });
        const imageP = runImage(d, image, hostDir).then((i) => {
          options.onUpdate?.(d.type, { field: "image", cell: i });
          return i;
        });
        const [version, host, imageResult] = await Promise.all([versionP, hostP, imageP]);
        return { type: d.type, hostVersion: version.host, imageVersion: version.image, drift: version.drift, host, image: imageResult };
      })
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export interface AgentLoginPlan {
  image: string;
  hostDir: string;
  dockerArgs: string[];
}

/** Agent types that support an interactive login through their image. */
export function loginableAgents(): string[] {
  return DESCRIPTORS.filter((d) => d.loginArgs).map((d) => d.type);
}

/**
 * Build the interactive `docker run` invocation that logs the user into an agent
 * through its image, writing credentials to the mounted host directory. The
 * caller runs the returned dockerArgs with inherited stdio (-it).
 */
export function planAgentLogin(
  type: string,
  cfg: OrchestratorConfig,
  workspaceDir: string,
  validateDockerBindPath: (name: string, value?: string, opts?: { containerPath?: boolean }) => string | null = validateBindPath
): { plan?: AgentLoginPlan; error?: string } {
  const d = DESCRIPTORS.find((x) => x.type === type);
  if (!d) return { error: `unknown agent '${type}'` };
  if (!d.loginArgs) {
    return { error: `${type} has no interactive login — authenticate via its API key (e.g. MISTRAL_API_KEY) or a pre-populated ${d.defaultHostDir}` };
  }
  const image = cfg.images[d.imageKey];
  if (!image) return { error: `no image configured for ${type}` };
  const hostDir = (cfg[d.hostDirKey] as string | undefined) ?? d.defaultHostDir;
  const invalidHostDir = validateDockerBindPath(d.envKey, hostDir);
  if (invalidHostDir) return { error: invalidHostDir };
  const invalidWorkspaceDir = validateDockerBindPath("workspace", workspaceDir);
  if (invalidWorkspaceDir) return { error: invalidWorkspaceDir };

  const dockerArgs = [
    "run", "--rm", "-it",
    "--security-opt", "no-new-privileges",
    "--cap-add", "CHOWN",
    "--network", "bridge",
    "--user", "0:0",
    "-v", `${workspaceDir}:${WORKSPACE}:rw`,
    "-v", `${hostDir}:${d.containerConfigPath}:rw`,
    "-e", "GH_TOKEN",
    ...(d.loginExtraArgs?.(cfg) ?? []),
    "-w", WORKSPACE,
    image,
    ...d.loginArgs,
  ];
  return { plan: { image, hostDir, dockerArgs } };
}

// ---------------------------------------------------------------------------
// Agent Tank — subscription usage (optional, external `agent-tank` CLI)
// ---------------------------------------------------------------------------

interface AgentTankMetric {
  label?: string;
  percent?: number;
  percentUsed?: number;
  resetsIn?: string;
}

interface AgentTankAgent {
  usage?: Record<string, AgentTankMetric>;
  metadata?: { email?: string; model?: string };
  error?: string | null;
}

export interface AgentTankUsage {
  installed: boolean;
  version?: string;
  usage?: Record<string, AgentTankAgent>;
  error?: string;
}

/**
 * Read subscription usage from the external `agent-tank` CLI (if installed),
 * via `agent-tank --once --json`. Tracks Claude/Codex/Antigravity plan limits;
 * never throws. Slow (it runs each CLI's /usage), so callers run it concurrently.
 */
export async function getAgentTankUsage(): Promise<AgentTankUsage> {
  if (!commandExists("agent-tank")) return { installed: false };

  const ver = await execAsync("agent-tank", ["--version"], { timeoutMs: 10_000 });
  const version = parseVersion(`${ver.stdout}\n${ver.stderr}`);

  const res = await execAsync("agent-tank", ["--once", "--json"], { timeoutMs: 90_000 });
  if (res.error?.code === "ETIMEDOUT") return { installed: true, version, error: "timed out reading usage" };
  try {
    const data = JSON.parse(res.stdout.trim()) as Record<string, AgentTankAgent>;
    return { installed: true, version, usage: data };
  } catch {
    const reason = (res.stderr || res.stdout || "could not parse agent-tank output").trim().split("\n").pop();
    return { installed: true, version, error: (reason || "could not parse agent-tank output").slice(0, 160) };
  }
}
