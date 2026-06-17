/**
 * Live agent validation for `propr check` (opt-in, see --validate-agents).
 *
 * Runs each agent's Docker image with a trivial prompt and the host credential
 * directory mounted, to confirm the agent can actually authenticate and respond
 * — the kind of end-to-end check that's most useful when run on the remote
 * server to debug a deployment.
 *
 * The per-agent invocations mirror @propr/core's agent buildDockerArgs / the
 * lightweight analyze() path (prompt on stdin for claude/codex/antigravity,
 * prompt file for opencode/vibe; vibe additionally remaps HOME). These are real
 * (billable) LLM calls. If the core runtime changes its invocation, update the
 * matching descriptor here.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { OrchestratorConfig, OrchestratorModule } from "../orchestrator/index.js";
import type { CheckResult } from "./checkCommands.js";

const VALIDATION_PROMPT = "Respond with exactly the word: OK";
const VALIDATION_TIMEOUT_MS = 120_000;
const WORKSPACE = "/home/node/workspace";
const PROMPT_FILE = "/home/node/propr-prompt.txt";

interface BuildContext {
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
  /** Full `docker` argv (after the executable) plus optional stdin payload. */
  build(ctx: BuildContext): { args: string[]; stdin?: string };
}

/** Common `docker run` prefix shared by the agent images (ends with the image). */
function baseArgs(
  image: string,
  hostDir: string,
  containerConfigPath: string,
  workspaceDir: string,
  opts: { env?: string[]; extra?: string[] } = {}
): string[] {
  return [
    "run",
    "--rm",
    "-i",
    "--security-opt",
    "no-new-privileges",
    "--cap-add",
    "CHOWN",
    "--network",
    "bridge",
    "--user",
    "0:0",
    "-v",
    `${workspaceDir}:${WORKSPACE}:rw`,
    "-v",
    `${hostDir}:${containerConfigPath}:rw`,
    "-e",
    `GH_TOKEN=${process.env.GH_TOKEN ?? ""}`,
    ...(opts.env ?? []),
    ...(opts.extra ?? []),
    "-w",
    WORKSPACE,
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
    build: ({ image, hostDir, workspaceDir }) => ({
      args: [
        ...baseArgs(image, hostDir, "/home/node/.claude", workspaceDir),
        "claude",
        "-p",
        "-",
        "--output-format",
        "text",
        "--dangerously-skip-permissions",
      ],
      stdin: VALIDATION_PROMPT,
    }),
  },
  {
    type: "codex",
    imageKey: "agent-codex",
    hostDirKey: "hostCodexDir",
    defaultHostDir: join(home, ".codex"),
    build: ({ image, hostDir, workspaceDir }) => ({
      args: [
        ...baseArgs(image, hostDir, "/home/node/.codex", workspaceDir, {
          extra: ["--security-opt", "seccomp=unconfined", "--security-opt", "apparmor=unconfined"],
        }),
        "codex",
        "exec",
        "--dangerously-bypass-approvals-and-sandbox",
        "--skip-git-repo-check",
        "--cd",
        WORKSPACE,
        "-",
      ],
      stdin: VALIDATION_PROMPT,
    }),
  },
  {
    type: "antigravity",
    imageKey: "agent-antigravity",
    hostDirKey: "hostAntigravityDir",
    defaultHostDir: join(home, ".gemini"),
    build: ({ image, hostDir, workspaceDir }) => ({
      args: [
        ...baseArgs(image, hostDir, "/home/node/.gemini", workspaceDir, {
          env: ["-e", "ANTIGRAVITY_CLI=1", "-e", "ANTIGRAVITY_CLI_TRUST_WORKSPACE=true"],
        }),
        "/bin/bash",
        "-lc",
        'set -e\nexec agy --dangerously-skip-permissions --print - "$@"',
        "propr-antigravity",
      ],
      stdin: VALIDATION_PROMPT,
    }),
  },
  {
    type: "opencode",
    imageKey: "agent-opencode",
    hostDirKey: "hostOpencodeXdgDir",
    defaultHostDir: join(home, ".config", "opencode"),
    build: ({ image, hostDir, workspaceDir, promptFileHost, cfg }) => {
      const extra = ["-v", `${promptFileHost}:${PROMPT_FILE}:ro`];
      if (cfg.hostOpencodeDataDir) {
        extra.push("-v", `${cfg.hostOpencodeDataDir}:/home/node/.local/share/opencode:rw`);
      }
      return {
        args: [
          ...baseArgs(image, hostDir, "/home/node/.config/opencode", workspaceDir, { extra }),
          "opencode",
          "run",
          "--file",
          PROMPT_FILE,
        ],
      };
    },
  },
  {
    type: "vibe",
    imageKey: "agent-vibe",
    hostDirKey: "hostVibeDir",
    defaultHostDir: join(home, ".vibe"),
    build: ({ image, hostDir, workspaceDir, promptFileHost }) => ({
      args: [
        ...baseArgs(image, hostDir, "/home/node/.vibe", workspaceDir, {
          env: [
            "-e",
            "VIBE_SOURCE_HOME=/home/node/.vibe",
            "-e",
            "VIBE_RUNTIME_HOME=/tmp/propr-vibe-home",
            "-e",
            "HOME=/tmp/propr-vibe-home",
          ],
          extra: ["-v", `${promptFileHost}:${PROMPT_FILE}:ro`],
        }),
        "--prompt-file",
        PROMPT_FILE,
      ],
    }),
  },
];

function imagePresent(orch: OrchestratorModule, tag: string): boolean {
  return orch.docker(["images", "-q", tag], { capture: true }).stdout.trim().length > 0;
}

export interface ValidateAgentsOptions {
  /** Restrict validation to these agent types (defaults to all). */
  agents?: string[];
  /** Progress callback fired before each agent runs. */
  onProgress?: (message: string) => void;
}

/**
 * Run a live validation prompt against each present agent image. Returns one
 * CheckResult per agent (group "Agents"). Agents whose image or credentials are
 * missing are reported as warnings and skipped (no call made).
 */
export async function validateAgents(
  orch: OrchestratorModule,
  cfg: OrchestratorConfig,
  options: ValidateAgentsOptions = {}
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const selected = options.agents?.length
    ? DESCRIPTORS.filter((d) => options.agents!.includes(d.type))
    : DESCRIPTORS;

  const tmp = mkdtempSync(join(tmpdir(), "propr-validate-"));
  const workspaceDir = join(tmp, "workspace");
  mkdirSync(workspaceDir, { recursive: true });
  const promptFileHost = join(tmp, "prompt.txt");
  writeFileSync(promptFileHost, `${VALIDATION_PROMPT}\n`);

  try {
    for (const descriptor of selected) {
      const name = `Validate: ${descriptor.type}`;
      const image = cfg.images[descriptor.imageKey];
      if (!image || !imagePresent(orch, image)) {
        results.push({ name, status: "warn", detail: `image ${image ?? descriptor.imageKey} not present — skipped`, group: "Agents" });
        continue;
      }
      const hostDir = (cfg[descriptor.hostDirKey] as string | undefined) ?? descriptor.defaultHostDir;
      if (!existsSync(hostDir)) {
        results.push({ name, status: "warn", detail: `credentials dir ${hostDir} not found — skipped`, group: "Agents" });
        continue;
      }

      options.onProgress?.(`running ${descriptor.type}…`);
      const { args, stdin } = descriptor.build({ image, hostDir, workspaceDir, promptFileHost, cfg });
      const run = spawnSync("docker", args, { input: stdin, encoding: "utf-8", timeout: VALIDATION_TIMEOUT_MS });

      if (run.status === 0) {
        const out = (run.stdout || "").trim().replace(/\s+/g, " ").slice(0, 80);
        results.push({ name, status: "ok", detail: out ? `responded: ${out}` : "responded", group: "Agents" });
      } else {
        const runError = run.error as NodeJS.ErrnoException | undefined;
        const reason =
          runError?.code === "ETIMEDOUT"
            ? `timed out after ${VALIDATION_TIMEOUT_MS / 1000}s`
            : ((run.stderr || run.stdout || runError?.message || "no output").trim().split("\n").pop() || "failed").slice(0, 200);
        results.push({
          name,
          status: "fail",
          detail: `agent call failed: ${reason}`,
          group: "Agents",
          fix: `Check ${descriptor.type} credentials/auth on this host (creds: ${hostDir}).`,
        });
      }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  return results;
}
