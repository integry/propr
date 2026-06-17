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
import { join } from "node:path";
import type { OrchestratorConfig, OrchestratorModule } from "../orchestrator/index.js";
import type { CheckResult } from "./checkCommands.js";

const VALIDATION_PROMPT = "Respond with only the word OK.";
const VALIDATION_TIMEOUT_MS = 120_000;
const VERSION_TIMEOUT_MS = 30_000;
const WORKSPACE = "/home/node/workspace";
const PROMPT_FILE = "/home/node/propr-prompt.txt";

// Treated as failure even when the process exits 0 (e.g. an agent that prints
// "Authentication required …" and exits cleanly).
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
  opts: { input?: string; cwd?: string; timeoutMs: number }
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"] });
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
  return (last ?? "").trim();
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
    return { ok: false, detail: `exit ${run.status ?? "?"}: ${(reason || "failed").slice(0, 160)}` };
  }
  const combined = `${run.stdout}\n${run.stderr}`;
  if (FAILURE_MARKERS.test(combined)) {
    const line = combined
      .replace(ANSI_RE, "")
      .split("\n")
      .map((l) => l.trim())
      .find((l) => FAILURE_MARKERS.test(l));
    return { ok: false, detail: (line || "authentication/availability error").slice(0, 160) };
  }
  const response = responseSummary(run.stdout, run.stderr);
  return { ok: true, detail: response ? `responded: ${response.slice(0, 100)}` : "responded" };
}

function parseVersion(text: string): string | undefined {
  const match = text.replace(ANSI_RE, "").match(/\b(\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.]+)?)\b/);
  return match?.[1];
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
  defaultHostDir: string;
  /** Host CLI binary name, or undefined when no host invocation is known. */
  hostBin?: string;
  hostInvocation?: (ctx: { prompt: string; promptFileHost: string }) => { args: string[]; stdin?: string };
  imageInvocation: (ctx: ImageContext) => { args: string[]; stdin?: string };
  /** Args (after the image) that print the CLI version inside the container. */
  versionArgs: string[];
}

/** Shared `docker run` prefix (ends with the image). */
function baseArgs(
  image: string,
  hostDir: string,
  containerConfigPath: string,
  workspaceDir: string,
  opts: { env?: string[]; extra?: string[] } = {}
): string[] {
  return [
    "run", "--rm", "-i",
    "--security-opt", "no-new-privileges",
    "--cap-add", "CHOWN",
    "--network", "bridge",
    "--user", "0:0",
    "-v", `${workspaceDir}:${WORKSPACE}:rw`,
    "-v", `${hostDir}:${containerConfigPath}:rw`,
    "-e", `GH_TOKEN=${process.env.GH_TOKEN ?? ""}`,
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
  },
  {
    type: "codex",
    imageKey: "agent-codex",
    hostDirKey: "hostCodexDir",
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
  },
  {
    type: "antigravity",
    imageKey: "agent-antigravity",
    hostDirKey: "hostAntigravityDir",
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
  },
  {
    type: "opencode",
    imageKey: "agent-opencode",
    hostDirKey: "hostOpencodeXdgDir",
    defaultHostDir: join(home, ".config", "opencode"),
    hostBin: "opencode",
    hostInvocation: ({ prompt }) => ({ args: ["run", prompt] }),
    imageInvocation: ({ image, hostDir, workspaceDir, cfg }) => {
      const extra = cfg.hostOpencodeDataDir
        ? ["-v", `${cfg.hostOpencodeDataDir}:/home/node/.local/share/opencode:rw`]
        : [];
      return {
        args: [
          ...baseArgs(image, hostDir, "/home/node/.config/opencode", workspaceDir, { extra }),
          "opencode", "run", VALIDATION_PROMPT,
        ],
      };
    },
    versionArgs: ["opencode", "--version"],
  },
  {
    type: "vibe",
    imageKey: "agent-vibe",
    hostDirKey: "hostVibeDir",
    defaultHostDir: join(home, ".vibe"),
    hostBin: "vibe",
    hostInvocation: ({ promptFileHost }) => ({ args: ["--prompt-file", promptFileHost] }),
    imageInvocation: ({ image, hostDir, workspaceDir, promptFileHost }) => ({
      args: [
        ...baseArgs(image, hostDir, "/home/node/.vibe", workspaceDir, {
          env: [
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
  },
];

function imagePresent(orch: OrchestratorModule, tag: string): boolean {
  return orch.docker(["images", "-q", tag], { capture: true }).stdout.trim().length > 0;
}

function commandExists(bin: string): boolean {
  return spawnSync("which", [bin], { encoding: "utf-8" }).status === 0;
}

export interface ValidateAgentsOptions {
  /** Restrict validation to these agent types (defaults to all). */
  agents?: string[];
  /** Progress callback fired once before the parallel run. */
  onProgress?: (message: string) => void;
}

interface OrderedResult {
  order: number;
  result: CheckResult;
}

async function versionResult(
  d: AgentValidationDescriptor,
  image: string | undefined,
  orch: OrchestratorModule
): Promise<CheckResult> {
  const name = `Version: ${d.type}`;
  const hostPromise = d.hostBin && commandExists(d.hostBin)
    ? execAsync(d.hostBin, ["--version"], { timeoutMs: VERSION_TIMEOUT_MS }).then((r) => parseVersion(`${r.stdout}\n${r.stderr}`))
    : Promise.resolve(undefined);
  const imagePromise = image && imagePresent(orch, image)
    ? execAsync("docker", ["run", "--rm", "--network=none", image, ...d.versionArgs], { timeoutMs: VERSION_TIMEOUT_MS }).then((r) => parseVersion(`${r.stdout}\n${r.stderr}`))
    : Promise.resolve(undefined);
  const [hostVersion, imageVersion] = await Promise.all([hostPromise, imagePromise]);

  if (!hostVersion && !imageVersion) {
    return { name, status: "warn", detail: "version not detected", group: "Agents" };
  }
  const parts: string[] = [];
  if (hostVersion) parts.push(`host ${hostVersion}`);
  if (imageVersion) parts.push(`image ${imageVersion}`);
  const differ = hostVersion && imageVersion && hostVersion !== imageVersion;
  return { name, status: "ok", detail: `${parts.join(" · ")}${differ ? " (differ)" : ""}`, group: "Agents" };
}

/**
 * Validate each present agent: version (host vs image), host CLI call, image
 * call — all in parallel. Returns CheckResults (group "Agents") in a stable
 * order (version, host, image per agent).
 */
export async function validateAgents(
  orch: OrchestratorModule,
  cfg: OrchestratorConfig,
  options: ValidateAgentsOptions = {}
): Promise<CheckResult[]> {
  const selected = options.agents?.length
    ? DESCRIPTORS.filter((d) => options.agents!.includes(d.type))
    : DESCRIPTORS;

  const tmp = mkdtempSync(join(tmpdir(), "propr-validate-"));
  const workspaceDir = join(tmp, "workspace");
  mkdirSync(workspaceDir, { recursive: true });
  const promptFileHost = join(tmp, "prompt.txt");
  writeFileSync(promptFileHost, `${VALIDATION_PROMPT}\n`);

  const tasks: Array<Promise<OrderedResult>> = [];
  let order = 0;
  const fixed = (o: number, result: CheckResult): Promise<OrderedResult> => Promise.resolve({ order: o, result });

  try {
    for (const d of selected) {
      const image = cfg.images[d.imageKey];
      const hostDir = (cfg[d.hostDirKey] as string | undefined) ?? d.defaultHostDir;

      // Version comparison (free).
      const ov = order++;
      tasks.push(versionResult(d, image, orch).then((result) => ({ order: ov, result })));

      // Level 1: host CLI (billable).
      if (d.hostInvocation && d.hostBin) {
        const o = order++;
        if (!commandExists(d.hostBin)) {
          tasks.push(fixed(o, { name: `Host: ${d.type}`, status: "warn", detail: `${d.hostBin} not installed on host — skipped`, group: "Agents" }));
        } else {
          const { args, stdin } = d.hostInvocation({ prompt: VALIDATION_PROMPT, promptFileHost });
          const bin = d.hostBin;
          tasks.push(
            execAsync(bin, args, { input: stdin, cwd: workspaceDir, timeoutMs: VALIDATION_TIMEOUT_MS }).then((run) => {
              const ev = evaluateRun(run);
              return {
                order: o,
                result: {
                  name: `Host: ${d.type}`,
                  status: ev.ok ? "ok" : "fail",
                  detail: ev.detail,
                  group: "Agents",
                  ...(ev.ok ? {} : { fix: `Run \`${bin} -p "test"\` on the host to debug ${d.type} auth.` }),
                } as CheckResult,
              };
            })
          );
        }
      }

      // Level 2: Docker image (billable).
      const oi = order++;
      if (!image || !imagePresent(orch, image)) {
        tasks.push(fixed(oi, { name: `Image: ${d.type}`, status: "warn", detail: `image ${image ?? d.imageKey} not present — skipped`, group: "Agents" }));
      } else if (!existsSync(hostDir)) {
        tasks.push(fixed(oi, { name: `Image: ${d.type}`, status: "warn", detail: `credentials dir ${hostDir} not found — skipped`, group: "Agents" }));
      } else {
        const { args, stdin } = d.imageInvocation({ image, hostDir, workspaceDir, promptFileHost, cfg });
        tasks.push(
          execAsync("docker", args, { input: stdin, timeoutMs: VALIDATION_TIMEOUT_MS }).then((run) => {
            const ev = evaluateRun(run);
            return {
              order: oi,
              result: {
                name: `Image: ${d.type}`,
                status: ev.ok ? "ok" : "fail",
                detail: ev.detail,
                group: "Agents",
                ...(ev.ok
                  ? {}
                  : { fix: `Check ${d.type} auth/mounts (creds: ${hostDir}). If "Host: ${d.type}" passed but this failed, it's a credential mount/config issue.` }),
              } as CheckResult,
            };
          })
        );
      }
    }

    options.onProgress?.(`running ${tasks.length} checks in parallel…`);
    const settled = await Promise.all(tasks);
    settled.sort((a, b) => a.order - b.order);
    return settled.map((s) => s.result);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
