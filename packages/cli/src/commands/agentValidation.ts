/**
 * Live agent validation for `propr check` (opt-in, see --validate-agents).
 *
 * Two levels per agent, both real (billable) LLM calls:
 *   1. Host CLI   — run the agent's CLI directly on the host (if installed),
 *                   using the host credentials as-is. Confirms the agent works
 *                   at all on this machine.
 *   2. Image      — run the agent's Docker image with the credential directory
 *                   mounted, mirroring how the worker invokes it.
 *
 * Comparing the two pinpoints failures: host OK + image FAIL ⇒ a credential
 * mount / container config problem rather than a bad credential.
 *
 * Image invocations mirror @propr/core's agent buildDockerArgs / analyze().
 * These are best-effort reconstructions — verify against real images on the host.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { OrchestratorConfig, OrchestratorModule } from "../orchestrator/index.js";
import type { CheckResult } from "./checkCommands.js";

const VALIDATION_PROMPT = "Respond with only the word OK.";
const VALIDATION_TIMEOUT_MS = 120_000;
const WORKSPACE = "/home/node/workspace";
const PROMPT_FILE = "/home/node/propr-prompt.txt";

// Treated as failure even when the process exits 0 (e.g. an agent that prints
// "Authentication required …" and exits cleanly).
const FAILURE_MARKERS =
  /authentication required|please (?:visit|log ?in|sign ?in|authenticate)|not (?:logged ?in|authenticated|signed ?in)|unauthorized|\b401\b|\b403\b|invalid (?:api ?key|credentials|token)|(?:missing|no) api key|api key (?:not|is missing|required)|login required|permission denied|errno 13|command not found|must provide a (?:message|command)|quota|rate limit/i;

// Container entrypoint / setup chatter to drop from the captured response.
const NOISE_MARKERS =
  /skipping firewall|gh_token|github token|safe\.directory|using legacy|config directory (?:available|not)|ownership|^warning:/i;

function cleanOutput(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !NOISE_MARKERS.test(line))
    .join(" ")
    .trim();
}

/** Classify a finished run as ok/fail with a concise human detail. */
function evaluateRun(run: ReturnType<typeof spawnSync>): { ok: boolean; detail: string } {
  const stdout = (run.stdout ?? "").toString();
  const stderr = (run.stderr ?? "").toString();
  const runError = run.error as NodeJS.ErrnoException | undefined;

  if (runError?.code === "ETIMEDOUT") {
    return { ok: false, detail: `timed out after ${VALIDATION_TIMEOUT_MS / 1000}s` };
  }
  if (run.status !== 0) {
    const reason = (stderr || stdout || runError?.message || "failed")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .pop();
    return { ok: false, detail: `exit ${run.status ?? "?"}: ${(reason || "failed").slice(0, 160)}` };
  }

  const combined = `${stdout}\n${stderr}`;
  if (FAILURE_MARKERS.test(combined)) {
    const line = combined
      .split("\n")
      .map((l) => l.trim())
      .find((l) => FAILURE_MARKERS.test(l));
    return { ok: false, detail: (line || "authentication/availability error").slice(0, 160) };
  }

  const cleaned = cleanOutput(stdout) || cleanOutput(stderr);
  return { ok: true, detail: cleaned ? `responded: ${cleaned.slice(0, 100)}` : "responded" };
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
  hostInvocation?: (prompt: string) => { args: string[]; stdin?: string };
  imageInvocation: (ctx: ImageContext) => { args: string[]; stdin?: string };
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
    hostInvocation: (prompt) => ({ args: ["-p", prompt, "--output-format", "text"] }),
    imageInvocation: ({ image, hostDir, workspaceDir }) => ({
      args: [
        ...baseArgs(image, hostDir, "/home/node/.claude", workspaceDir),
        "claude", "-p", "-", "--output-format", "text", "--dangerously-skip-permissions",
      ],
      stdin: VALIDATION_PROMPT,
    }),
  },
  {
    type: "codex",
    imageKey: "agent-codex",
    hostDirKey: "hostCodexDir",
    defaultHostDir: join(home, ".codex"),
    hostBin: "codex",
    hostInvocation: (prompt) => ({ args: ["exec", "--skip-git-repo-check", prompt] }),
    imageInvocation: ({ image, hostDir, workspaceDir }) => ({
      args: [
        ...baseArgs(image, hostDir, "/home/node/.codex", workspaceDir, {
          extra: ["--security-opt", "seccomp=unconfined", "--security-opt", "apparmor=unconfined"],
        }),
        "codex", "exec", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check", "--cd", WORKSPACE, "-",
      ],
      stdin: VALIDATION_PROMPT,
    }),
  },
  {
    type: "antigravity",
    imageKey: "agent-antigravity",
    hostDirKey: "hostAntigravityDir",
    defaultHostDir: join(home, ".gemini"),
    hostBin: "agy",
    hostInvocation: (prompt) => ({ args: ["-p", prompt] }),
    imageInvocation: ({ image, hostDir, workspaceDir }) => ({
      args: [
        ...baseArgs(image, hostDir, "/home/node/.gemini", workspaceDir, {
          env: ["-e", "ANTIGRAVITY_CLI=1", "-e", "ANTIGRAVITY_CLI_TRUST_WORKSPACE=true"],
        }),
        "/bin/bash", "-lc", 'set -e\nexec agy --dangerously-skip-permissions --print - "$@"', "propr-antigravity",
      ],
      stdin: VALIDATION_PROMPT,
    }),
  },
  {
    type: "opencode",
    imageKey: "agent-opencode",
    hostDirKey: "hostOpencodeXdgDir",
    defaultHostDir: join(home, ".config", "opencode"),
    hostBin: "opencode",
    hostInvocation: (prompt) => ({ args: ["run", prompt] }),
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
  },
  {
    type: "vibe",
    imageKey: "agent-vibe",
    hostDirKey: "hostVibeDir",
    defaultHostDir: join(home, ".vibe"),
    // Host vibe invocation is not well-defined here; skip the host level.
    imageInvocation: ({ image, hostDir, workspaceDir, promptFileHost }) => ({
      args: [
        ...baseArgs(image, hostDir, "/home/node/.vibe", workspaceDir, {
          // Full XDG/HOME remap so vibe never touches the (absent) host home.
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

/**
 * Validate each present agent at the host and image levels, in parallel. Returns
 * CheckResults (group "Agents") in a stable order (host then image, per agent).
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

  const ok = (o: number, result: CheckResult): Promise<OrderedResult> => Promise.resolve({ order: o, result });

  try {
    for (const d of selected) {
      const image = cfg.images[d.imageKey];
      const hostDir = (cfg[d.hostDirKey] as string | undefined) ?? d.defaultHostDir;

      // Level 1: host CLI.
      if (d.hostInvocation && d.hostBin) {
        const o = order++;
        if (!commandExists(d.hostBin)) {
          tasks.push(ok(o, { name: `Host: ${d.type}`, status: "warn", detail: `${d.hostBin} not installed on host — skipped`, group: "Agents" }));
        } else {
          const { args, stdin } = d.hostInvocation(VALIDATION_PROMPT);
          const bin = d.hostBin;
          tasks.push(
            (async () => {
              const run = spawnSync(bin, args, { input: stdin, cwd: workspaceDir, encoding: "utf-8", timeout: VALIDATION_TIMEOUT_MS });
              const ev = evaluateRun(run);
              return {
                order: o,
                result: {
                  name: `Host: ${d.type}`,
                  status: ev.ok ? "ok" : "fail",
                  detail: ev.detail,
                  group: "Agents",
                  ...(ev.ok ? {} : { fix: `Run \`${bin} -p "test"\` on the host to debug ${d.type} auth.` }),
                },
              };
            })()
          );
        }
      }

      // Level 2: Docker image.
      const oi = order++;
      if (!image || !imagePresent(orch, image)) {
        tasks.push(ok(oi, { name: `Image: ${d.type}`, status: "warn", detail: `image ${image ?? d.imageKey} not present — skipped`, group: "Agents" }));
      } else if (!existsSync(hostDir)) {
        tasks.push(ok(oi, { name: `Image: ${d.type}`, status: "warn", detail: `credentials dir ${hostDir} not found — skipped`, group: "Agents" }));
      } else {
        const { args, stdin } = d.imageInvocation({ image, hostDir, workspaceDir, promptFileHost, cfg });
        tasks.push(
          (async () => {
            const run = spawnSync("docker", args, { input: stdin, encoding: "utf-8", timeout: VALIDATION_TIMEOUT_MS });
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
              },
            };
          })()
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
