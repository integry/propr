import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants,
  cpSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  AGENT_SKILL_TARGETS,
  detectConfiguredAgentSkillTargets,
  inspectAgentSkills,
  installAgentSkill,
  parseAgentSkillTargets,
  removeAgentSkill,
  resolveAgentSkillLocations,
  type AgentSkillEnvironment,
} from "./agentSkill.js";
import {
  DARWIN_DIRECTORY_OPERATION_SHA256,
  LINUX_DIRECTORY_OPERATION_SHA256,
  directoryDescriptorAccess,
  verifyDirectoryOperationArtifact,
} from "./utils/directoryDescriptor.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(): string {
  // macOS reports /var in os.tmpdir(), while /var is a symlink to
  // /private/var. Canonicalize the disposable fixture root so production's
  // no-symlink ancestor policy is still exercised without rejecting tmpdir.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "propr-agent-skill-test-")));
  roots.push(root);
  return root;
}

test("uses only the host platform's real directory-descriptor behavior", () => {
  assert.throws(() => directoryDescriptorAccess("win32"), /not supported/);
  if (process.platform === "linux") assert.equal(directoryDescriptorAccess(), "child-paths");
  else if (process.platform === "darwin") assert.equal(directoryDescriptorAccess(), "native-at");
  else assert.throws(() => directoryDescriptorAccess(), /not supported/);
});

test("ships integrity-pinned native helpers for every supported platform and architecture", () => {
  assert.deepEqual(Object.keys(DARWIN_DIRECTORY_OPERATION_SHA256).sort(), ["arm64", "x64"]);
  assert.deepEqual(Object.keys(LINUX_DIRECTORY_OPERATION_SHA256).sort(), ["arm64", "x64"]);
  const nativeRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "native", "prebuilds");
  for (const [platform, digests] of [
    ["darwin", DARWIN_DIRECTORY_OPERATION_SHA256],
    ["linux", LINUX_DIRECTORY_OPERATION_SHA256],
  ] as const) {
    for (const [arch, digest] of Object.entries(digests)) {
      const artifact = join(nativeRoot, `${platform}-${arch}`, "directory-operations.node");
      verifyDirectoryOperationArtifact(artifact, digest, `${platform}-${arch}`);
    }
  }

  const root = temporaryRoot();
  const tampered = join(root, "directory-operations.node");
  writeFileSync(tampered, Buffer.from("not a native artifact"));
  assert.throws(
    () => verifyDirectoryOperationArtifact(tampered, DARWIN_DIRECTORY_OPERATION_SHA256.arm64, "arm64"),
    /failed integrity verification/
  );
});

test("native Darwin child uses inherited fd 3 without changing either cwd", {
  skip: process.platform !== "darwin" ? "requires a real Darwin kernel and packaged Darwin addon" : false,
}, () => {
  const root = temporaryRoot();
  const held = join(root, "held");
  const detached = join(root, "detached");
  const outside = join(root, "outside");
  mkdirSync(held);
  mkdirSync(outside);
  const sentinel = join(outside, "sentinel.bin");
  const sentinelContent = Buffer.from([0x00, 0xff, 0x51, 0x9a]);
  writeFileSync(sentinel, sentinelContent);
  const fd = openSync(held, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const originalCwd = process.cwd();
  try {
    renameSync(held, detached);
    symlinkSync(outside, held, "dir");
    const artifact = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "native",
      "prebuilds",
      `darwin-${process.arch}`,
      "directory-operations.node"
    );
    const childScript = String.raw`
      const fs = require("node:fs");
      const native = require(process.argv[1]);
      const before = process.cwd();
      native.mkdirAt(3, "created", 0o700);
      const child = native.openAt(3, "created", fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW, 0);
      const temporary = native.openAt(child, "temporary", fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      fs.writeFileSync(temporary, "pinned\n");
      fs.closeSync(temporary);
      native.linkAt(child, "temporary", child, "linked", 0);
      native.renameAt(child, "linked", child, "renamed");
      const status = native.lstatAt(child, "renamed");
      native.unlinkAt(child, "temporary", 0);
      fs.closeSync(child);
      if (status.kind !== "file" || process.cwd() !== before) process.exit(2);
      process.stdout.write(before);
    `;
    const child = spawnSync(process.execPath, ["-e", childScript, artifact], {
      cwd: originalCwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe", fd],
    });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout, originalCwd);
  } finally {
    closeSync(fd);
  }

  assert.equal(process.cwd(), originalCwd);
  assert.equal(lstatSync(held).isSymbolicLink(), true);
  assert.equal(readFileSync(join(detached, "created", "renamed"), "utf8"), "pinned\n");
  assert.equal(existsSync(join(outside, "created")), false);
  assert.deepEqual(readFileSync(sentinel), sentinelContent);
});

function environment(root: string): AgentSkillEnvironment {
  return {
    HOME: join(root, "home"),
    CODEX_HOME: join(root, "codex-home"),
    XDG_CONFIG_HOME: join(root, "xdg"),
  };
}

function bundle(root: string, body: string): string {
  const path = join(root, `bundle-${body.replace(/\W/g, "-")}`);
  mkdirSync(join(path, "agents"), { recursive: true });
  writeFileSync(join(path, "SKILL.md"), `---\nname: propr\ndescription: ${body}\n---\n\n# ProPR\n\n${body}\n`);
  writeFileSync(join(path, "agents", "openai.yaml"), `interface:\n  display_name: "ProPR Operator"\n  short_description: "${body}"\n  default_prompt: "Use $propr for this change."\n`);
  return path;
}

test("the real host implementation supports every required provider lifecycle", () => {
  const root = temporaryRoot();
  const env = environment(root);
  mkdirSync(env.HOME!, { recursive: true });
  const older = bundle(root, "older portable skill");
  const current = bundle(root, "current portable skill");

  for (const target of AGENT_SKILL_TARGETS) {
    assert.equal(installAgentSkill(target, { env, bundleDir: older }).action, "installed");
    assert.equal(removeAgentSkill(target, { env, bundleDir: older }).action, "removed");

    const targetPath = resolveAgentSkillLocations([target], env)[0].path;
    cpSync(older, targetPath, { recursive: true });
    assert.equal(installAgentSkill(target, { env, bundleDir: older }).action, "adopted");
    assert.equal(installAgentSkill(target, { env, bundleDir: current }).action, "updated");

    writeFileSync(join(targetPath, "SKILL.md"), "modified managed content\n");
    const replaced = installAgentSkill(target, { env, bundleDir: current, force: true });
    assert.equal(replaced.action, "backed-up");
    assert.ok(replaced.backupPath);

    assert.equal(removeAgentSkill(target, { env, bundleDir: current }).action, "removed");
    mkdirSync(targetPath);
    writeFileSync(join(targetPath, "foreign.txt"), "foreign content\n");
    const forcedRemoval = removeAgentSkill(target, { env, bundleDir: current, force: true });
    assert.equal(forcedRemoval.action, "backed-up");
    assert.ok(forcedRemoval.backupPath);
  }
});

function dateWithOneShotSideEffect(sideEffect: () => void): Date {
  let fired = false;
  return {
    toISOString() {
      if (!fired) {
        fired = true;
        sideEffect();
      }
      return "2026-08-14T10:24:00.000Z";
    },
  } as Date;
}

const canonicalSkill = readFileSync(new URL("../skill/propr/SKILL.md", import.meta.url), "utf8");
const canonicalOpenAiMetadata = readFileSync(new URL("../skill/propr/agents/openai.yaml", import.meta.url), "utf8");

test("bundled skill leads with ProPR delegation value and a GitHub-primary workflow", () => {
  assert.match(canonicalSkill, /GitHub issues, managed labels, pull-request comments, and slash commands become durable tasks/);
  assert.match(canonicalSkill, /agents run in isolated execution containers/);
  assert.match(canonicalSkill, /ProPR deterministically owns worktrees, commits, branches, pushes, PR creation, task evidence, retries and recovery, and status/);
  for (const value of [
    "auditable issue-to-PR provenance",
    "deterministic Git operations",
    "isolated credentials and workspaces",
    "model routing",
    "safe parallel work across different PRs",
    "durable recovery and observability",
    "standardized independent review gates",
  ]) {
    assert.ok(canonicalSkill.includes(value), `missing why-delegate value: ${value}`);
  }

  assert.match(canonicalSkill, /GitHub as the primary and sufficient control surface/);
  assert.match(canonicalSkill, /Through GitHub or `gh`, create or edit issues and labels, monitor the generated PR and checks/);
  assert.match(canonicalSkill, /CLI is useful for installation, host lifecycle, and extra observability, but it is not mandatory for most orchestration/);
  assert.match(canonicalSkill, /one narrowly scoped GitHub issue\. State the desired outcome, constraints, and testable acceptance criteria/);
  assert.match(canonicalSkill, /Inspect the task status and evidence, the exact generated PR diff, and all required checks/);
  assert.match(canonicalSkill, /factual natural-language PR comment describing the observed problem, expected result, and relevant evidence/);
  assert.match(canonicalSkill, /Merge the PR only when authorized and only at the reviewed and tested head/);
  assert.match(canonicalSkill, /Keep release publication and deployment as explicit later gates/);
  for (const command of ["propr setup", "propr status", "propr repo list", "propr agent list", "propr check agents", "propr task list"]) {
    assert.ok(canonicalSkill.includes(command), `missing optional CLI example: ${command}`);
  }
});

test("bundled skill makes AI-only routing the default and model labels optional overrides", () => {
  assert.match(canonicalSkill, /Normally add `AI` by itself\. ProPR then uses the configured default agent and default model/);
  assert.match(canonicalSkill, /Only when an intentional model override is useful/);
  assert.match(canonicalSkill, /`llm-<agent-or-provider-alias>-<model-alias>`/);
  assert.match(canonicalSkill, /gh label list --repo OWNER\/REPO --search "llm-"/);
  assert.match(canonicalSkill, /Prefer stable short-form aliases exposed by the repository/);
  for (const label of ["llm-claude-opus", "llm-claude-sonnet", "llm-gemini-pro", "llm-vibe-mistral", "llm-codex-max"]) {
    assert.ok(canonicalSkill.includes(label), `missing stable model-label example: ${label}`);
  }
  assert.match(canonicalSkill, /Version-specific labels age quickly; use one only when exact-model qualification is intentional/);
  assert.match(canonicalSkill, /If no appropriate override label exists, use `AI` alone rather than guessing/);

  const overrideLabel = "gh issue edit ISSUE --repo OWNER/REPO --add-label llm-codex-max";
  const overrideSection = canonicalSkill.slice(canonicalSkill.indexOf("Intentional override"));
  assert.ok(overrideSection.indexOf(overrideLabel) < overrideSection.indexOf("gh issue edit ISSUE --repo OWNER/REPO --add-label AI"));
  assert.match(canonicalSkill, /Keep only one managed model label on a PR\. For later model transitions, use ProPR `\/use`/);
});

test("bundled skill fixes PR command meanings and the deterministic Git boundary", () => {
  assert.match(canonicalSkill, /Natural-language comment: queue a scoped implementation or refinement follow-up/);
  assert.match(canonicalSkill, /`\/fix` or `\/fix F…`: implement all pending review blockers or the selected findings/);
  assert.match(canonicalSkill, /`\/review \[model\]`: request an independent AI review/);
  assert.match(canonicalSkill, /`\/ultrafix goal=8 max=10`: alternate review and blocker fixes until the score goal or maximum-cycle boundary/);
  assert.match(canonicalSkill, /`\/use <model>`: select the durable PR route for queued and future work and converge the PR to one managed model label/);
  assert.match(canonicalSkill, /Use `\/switch` only if current PR help still lists it as a supported alias/);
  assert.match(canonicalSkill, /`\/merge`: merge the base branch into the PR branch and resolve conflicts\. It does not merge the PR into the base branch/);
  assert.match(canonicalSkill, /edit and test only\. Do not commit, push, repair Git permissions, or create another ProPR task recursively\. ProPR finalizes Git changes/);
});

test("OpenAI metadata stays aligned with the GitHub delegation workflow", () => {
  assert.match(canonicalOpenAiMetadata, /short_description: "Delegate GitHub issue-to-PR work through ProPR"/);
  assert.match(canonicalOpenAiMetadata, /default_prompt: "Use \$propr to delegate this change through GitHub and independently verify the resulting pull request\."/);
});

test("resolves every confirmed target with isolated HOME, CODEX_HOME, and XDG_CONFIG_HOME", () => {
  const root = temporaryRoot();
  const env = environment(root);
  mkdirSync(env.HOME!, { recursive: true });
  const byTarget = Object.fromEntries(resolveAgentSkillLocations(AGENT_SKILL_TARGETS, env).map((value) => [value.target, value.path]));

  assert.equal(byTarget.codex, join(env.CODEX_HOME!, "skills", "propr"));
  assert.equal(byTarget.claude, join(env.HOME!, ".claude", "skills", "propr"));
  assert.equal(byTarget.antigravity, join(env.HOME!, ".gemini", "antigravity-cli", "skills", "propr"));
  assert.equal(byTarget.opencode, join(env.XDG_CONFIG_HOME!, "opencode", "skills", "propr"));
  assert.equal(byTarget.vibe, join(env.HOME!, ".vibe", "skills", "propr"));
});

test("blank optional home overrides use their required fallbacks", () => {
  const root = temporaryRoot();
  const home = join(root, "home");
  const byTarget = Object.fromEntries(resolveAgentSkillLocations(["codex", "opencode"], {
    HOME: home,
    CODEX_HOME: "  ",
    XDG_CONFIG_HOME: "",
  }).map((value) => [value.target, value.path]));

  assert.equal(byTarget.codex, join(home, ".codex", "skills", "propr"));
  assert.equal(byTarget.opencode, join(home, ".config", "opencode", "skills", "propr"));
  assert.throws(() => resolveAgentSkillLocations(["codex"], { HOME: "" }), /HOME is empty/);
});

test("explicit Codex and OpenCode roots do not require HOME", () => {
  const root = temporaryRoot();
  const overrides = {
    CODEX_HOME: join(root, "codex-home"),
    XDG_CONFIG_HOME: join(root, "xdg"),
  };

  for (const env of [overrides, { ...overrides, HOME: "/" }]) {
    const byTarget = Object.fromEntries(resolveAgentSkillLocations(["codex", "opencode"], env).map((value) => [value.target, value.path]));
    assert.equal(byTarget.codex, join(overrides.CODEX_HOME, "skills", "propr"));
    assert.equal(byTarget.opencode, join(overrides.XDG_CONFIG_HOME, "opencode", "skills", "propr"));
  }
});

test("parses comma-separated, repeated, and all target selections", () => {
  assert.deepEqual(parseAgentSkillTargets(["codex,claude", "codex"]), ["codex", "claude"]);
  assert.deepEqual(parseAgentSkillTargets(["all"]), AGENT_SKILL_TARGETS);
  assert.throws(() => parseAgentSkillTargets(["unknown"]), /unknown agent skill target/);
  assert.throws(() => parseAgentSkillTargets(["all,unknown"]), /unknown agent skill target/);
});

test("allows provider-specific paths for a direct root session", (t) => {
  t.mock.method(process as unknown as { geteuid: () => number }, "geteuid", () => 0);
  const locations = resolveAgentSkillLocations(AGENT_SKILL_TARGETS, { HOME: "/root" });
  assert.deepEqual(
    locations.map(({ path }) => path),
    [
      "/root/.codex/skills/propr",
      "/root/.claude/skills/propr",
      "/root/.gemini/antigravity-cli/skills/propr",
      "/root/.config/opencode/skills/propr",
      "/root/.vibe/skills/propr",
    ]
  );
});

test("refuses sudo-inherited, non-root, traversal, and broad root-like targets", (t) => {
  t.mock.method(process as unknown as { geteuid: () => number }, "geteuid", () => 0);
  assert.throws(() => resolveAgentSkillLocations(["codex"], { HOME: "/root", SUDO_USER: "operator" }), /not through sudo/);
  assert.throws(() => resolveAgentSkillLocations(["codex"], { HOME: "/root", SUDO_UID: "1000" }), /not through sudo/);
  assert.throws(() => resolveAgentSkillLocations(["codex"], { HOME: "/" }), /broad root path/);
  assert.throws(() => resolveAgentSkillLocations(["codex"], { HOME: "/root", CODEX_HOME: "/root" }), /root-owned/);
  assert.throws(() => resolveAgentSkillLocations(["opencode"], { HOME: "/root", XDG_CONFIG_HOME: "/root" }), /root-owned/);
  assert.throws(() => resolveAgentSkillLocations(["codex"], { HOME: "/root/../escape" }), /traversal/);

  t.mock.restoreAll();
  t.mock.method(process as unknown as { geteuid: () => number }, "geteuid", () => 1000);
  assert.throws(() => resolveAgentSkillLocations(["codex"], { HOME: "/root" }), /root-owned/);
});

test("fresh install is private and exact reinstall is a no-op", () => {
  const root = temporaryRoot();
  const env = environment(root);
  mkdirSync(env.HOME!, { recursive: true });
  const source = bundle(root, "current skill");

  const first = installAgentSkill("codex", { env, bundleDir: source });
  assert.equal(first.action, "installed");
  assert.equal(first.state, "current-managed");
  const target = resolveAgentSkillLocations(["codex"], env)[0].path;
  const before = readFileSync(join(target, ".propr-managed.json"), "utf8");
  const second = installAgentSkill("codex", { env, bundleDir: source });
  assert.equal(second.action, "unchanged");
  assert.equal(readFileSync(join(target, ".propr-managed.json"), "utf8"), before);
});

test("an unmodified managed older bundle upgrades but a modified copy is refused", () => {
  const root = temporaryRoot();
  const env = environment(root);
  mkdirSync(env.HOME!, { recursive: true });
  const older = bundle(root, "older skill");
  const current = bundle(root, "current skill");

  assert.equal(installAgentSkill("claude", { env, bundleDir: older }).action, "installed");
  assert.equal(inspectAgentSkills(["claude"], { env, bundleDir: current })[0].state, "outdated-managed");
  const upgraded = installAgentSkill("claude", { env, bundleDir: current });
  assert.equal(upgraded.action, "updated");
  assert.ok(upgraded.backupPath);
  assert.match(readFileSync(join(upgraded.backupPath!, "SKILL.md"), "utf8"), /older skill/);

  const target = resolveAgentSkillLocations(["claude"], env)[0].path;
  writeFileSync(join(target, "SKILL.md"), "user changed this\n");
  const refused = installAgentSkill("claude", { env, bundleDir: current });
  assert.equal(refused.action, "refused");
  assert.equal(refused.state, "modified-managed");
});

test("non-forced upgrade revalidates and preserves a target changed just before detachment", () => {
  const root = temporaryRoot();
  const env = environment(root);
  mkdirSync(env.HOME!, { recursive: true });
  const older = bundle(root, "older skill");
  const current = bundle(root, "current skill");
  assert.equal(installAgentSkill("claude", { env, bundleDir: older }).action, "installed");
  const target = resolveAgentSkillLocations(["claude"], env)[0].path;
  const now = dateWithOneShotSideEffect(() => {
    writeFileSync(join(target, "concurrent.txt"), "changed concurrently\n");
  });

  const result = installAgentSkill("claude", { env, bundleDir: current, now });

  assert.equal(result.action, "failed");
  assert.match(result.detail ?? "", /changed before replacement and was not overwritten/);
  assert.ok(result.backupPath);
  assert.equal(existsSync(target), false);
  assert.equal(readFileSync(join(result.backupPath!, "concurrent.txt"), "utf8"), "changed concurrently\n");
});

test("an exact unmanaged copy is adopted and then participates in managed upgrades", () => {
  const root = temporaryRoot();
  const env = environment(root);
  mkdirSync(env.HOME!, { recursive: true });
  const older = bundle(root, "older unmanaged skill");
  const current = bundle(root, "current managed skill");
  const target = resolveAgentSkillLocations(["claude"], env)[0].path;
  cpSync(older, target, { recursive: true });

  assert.equal(inspectAgentSkills(["claude"], { env, bundleDir: older })[0].state, "current-unmanaged");
  const adopted = installAgentSkill("claude", { env, bundleDir: older });
  assert.equal(adopted.action, "adopted");
  assert.equal(adopted.state, "current-managed");
  assert.ok(existsSync(join(target, ".propr-managed.json")));
  assert.equal(statSync(join(target, ".propr-managed.json")).mode & 0o777, 0o600);

  assert.equal(inspectAgentSkills(["claude"], { env, bundleDir: current })[0].state, "outdated-managed");
  assert.equal(installAgentSkill("claude", { env, bundleDir: current }).action, "updated");
});

test("never adopts non-exact unmanaged content", () => {
  const root = temporaryRoot();
  const env = environment(root);
  mkdirSync(env.HOME!, { recursive: true });
  const source = bundle(root, "current skill");
  const target = resolveAgentSkillLocations(["vibe"], env)[0].path;
  cpSync(source, target, { recursive: true });
  writeFileSync(join(target, "SKILL.md"), "modified unmanaged content\n");

  const result = installAgentSkill("vibe", { env, bundleDir: source });
  assert.equal(result.action, "refused");
  assert.equal(result.state, "foreign");
  assert.equal(existsSync(join(target, ".propr-managed.json")), false);
});

test("length-delimited identities reject a tree that collides under NUL-delimited entry encoding", () => {
  const root = temporaryRoot();
  const env = environment(root);
  mkdirSync(env.HOME!, { recursive: true });
  const source = bundle(root, "identity collision skill");
  writeFileSync(join(source, "zA"), "x");
  writeFileSync(join(source, "zB"), "y");

  const target = resolveAgentSkillLocations(["claude"], env)[0].path;
  cpSync(source, target, { recursive: true });
  rmSync(join(target, "zB"));
  writeFileSync(join(target, "zA"), Buffer.from("x\0F\0zB\0y"));

  const inspected = inspectAgentSkills(["claude"], { env, bundleDir: source })[0];
  assert.equal(inspected.state, "foreign");
  const result = installAgentSkill("claude", { env, bundleDir: source });
  assert.equal(result.action, "refused");
  assert.equal(result.state, "foreign");
  assert.equal(existsSync(join(target, ".propr-managed.json")), false);
});

test("foreign content is refused by default and force replacement keeps a timestamped backup", () => {
  const root = temporaryRoot();
  const env = environment(root);
  mkdirSync(env.HOME!, { recursive: true });
  const source = bundle(root, "current skill");
  const target = resolveAgentSkillLocations(["vibe"], env)[0].path;
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "SKILL.md"), "foreign\n");

  assert.equal(installAgentSkill("vibe", { env, bundleDir: source }).action, "refused");
  const forced = installAgentSkill("vibe", { env, bundleDir: source, force: true, now: new Date("2026-08-14T10:24:00Z") });
  assert.equal(forced.action, "backed-up");
  assert.ok(forced.backupPath?.includes(".propr.backup-20260814102400000"));
  assert.equal(readFileSync(join(forced.backupPath!, "SKILL.md"), "utf8"), "foreign\n");
});

test("safe removal accepts only unmodified managed content unless force preserves a backup", () => {
  const root = temporaryRoot();
  const env = environment(root);
  mkdirSync(env.HOME!, { recursive: true });
  const source = bundle(root, "current skill");

  installAgentSkill("opencode", { env, bundleDir: source });
  const removed = removeAgentSkill("opencode", { env, bundleDir: source });
  assert.equal(removed.action, "removed");
  assert.ok(removed.backupPath);
  assert.ok(existsSync(join(removed.backupPath!, "SKILL.md")));
  assert.equal(inspectAgentSkills(["opencode"], { env, bundleDir: source })[0].state, "absent");

  const target = resolveAgentSkillLocations(["opencode"], env)[0].path;
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "SKILL.md"), "foreign\n");
  assert.equal(removeAgentSkill("opencode", { env, bundleDir: source }).action, "refused");
  const forced = removeAgentSkill("opencode", { env, bundleDir: source, force: true });
  assert.equal(forced.action, "backed-up");
  assert.ok(forced.backupPath);
});

test("non-forced removal revalidates and preserves a target changed just before detachment", () => {
  const root = temporaryRoot();
  const env = environment(root);
  mkdirSync(env.HOME!, { recursive: true });
  const source = bundle(root, "current skill");
  assert.equal(installAgentSkill("opencode", { env, bundleDir: source }).action, "installed");
  const target = resolveAgentSkillLocations(["opencode"], env)[0].path;
  const now = dateWithOneShotSideEffect(() => {
    writeFileSync(join(target, "concurrent.txt"), "changed concurrently\n");
  });

  const result = removeAgentSkill("opencode", { env, bundleDir: source, now });

  assert.equal(result.action, "failed");
  assert.match(result.detail ?? "", /changed before removal and was not deleted/);
  assert.ok(result.backupPath);
  assert.equal(existsSync(target), false);
  assert.equal(readFileSync(join(result.backupPath!, "concurrent.txt"), "utf8"), "changed concurrently\n");
});

test("rejects traversal, root-owned homes, non-directory parents, and skill-parent symlinks", () => {
  const root = temporaryRoot();
  const source = bundle(root, "current skill");
  assert.throws(() => resolveAgentSkillLocations(["codex"], { HOME: `${root}/home/../escape` }), /traversal/);
  assert.throws(() => resolveAgentSkillLocations(["codex"], { HOME: "/root" }), /root-owned/);

  const env = environment(root);
  mkdirSync(env.HOME!, { recursive: true });
  mkdirSync(env.CODEX_HOME!, { recursive: true });
  const outside = join(root, "outside");
  mkdirSync(outside);
  symlinkSync(outside, join(env.CODEX_HOME!, "skills"));
  const result = installAgentSkill("codex", { env, bundleDir: source });
  assert.equal(result.action, "refused");
  assert.equal(result.state, "unsafe");

  const linkedHome = join(root, "linked-home");
  mkdirSync(linkedHome);
  symlinkSync(outside, join(linkedHome, ".gemini"));
  const intermediate = installAgentSkill("antigravity", {
    env: { HOME: linkedHome },
    bundleDir: source,
  });
  assert.equal(intermediate.action, "refused");
  assert.equal(intermediate.state, "unsafe");

  const directTargetEnv = { HOME: join(root, "direct-target-home") };
  mkdirSync(join(directTargetEnv.HOME, ".vibe", "skills"), { recursive: true });
  symlinkSync(outside, join(directTargetEnv.HOME, ".vibe", "skills", "propr"));
  const directTarget = installAgentSkill("vibe", { env: directTargetEnv, bundleDir: source });
  assert.equal(directTarget.action, "refused");
  assert.equal(directTarget.state, "unsafe");

  const otherEnv = { HOME: join(root, "other-home"), CODEX_HOME: join(root, "parent-file", "codex") };
  mkdirSync(otherEnv.HOME, { recursive: true });
  writeFileSync(join(root, "parent-file"), "not a directory");
  assert.equal(installAgentSkill("codex", { env: otherEnv, bundleDir: source }).action, "refused");
});

test("classifies dangling target and parent symlinks as unsafe", () => {
  const root = temporaryRoot();
  const source = bundle(root, "current skill");

  const targetEnv = { HOME: join(root, "target-home") };
  const target = resolveAgentSkillLocations(["vibe"], targetEnv)[0].path;
  mkdirSync(join(target, ".."), { recursive: true });
  symlinkSync(join(root, "missing-target"), target);

  const targetStatus = inspectAgentSkills(["vibe"], { env: targetEnv, bundleDir: source })[0];
  assert.equal(targetStatus.state, "unsafe");
  assert.match(targetStatus.detail ?? "", /symbolic link target is not allowed/);
  assert.equal(installAgentSkill("vibe", { env: targetEnv, bundleDir: source }).action, "refused");

  const danglingParent = join(root, "dangling-parent");
  symlinkSync(join(root, "missing-parent"), danglingParent);
  const parentStatus = inspectAgentSkills(["codex"], {
    env: { HOME: join(root, "parent-home"), CODEX_HOME: join(danglingParent, "codex") },
    bundleDir: source,
  })[0];
  assert.equal(parentStatus.state, "unsafe");
  assert.match(parentStatus.detail ?? "", /symbolic link parent is not allowed/);
});

test("detects only tool-specific configured homes", () => {
  const root = temporaryRoot();
  const env = environment(root);
  mkdirSync(join(env.HOME!, ".claude"), { recursive: true });
  mkdirSync(join(env.XDG_CONFIG_HOME!, "opencode"), { recursive: true });
  assert.deepEqual(detectConfiguredAgentSkillTargets(env).map(({ target }) => target), ["claude", "opencode"]);
});

test("detects an installed tool from PATH without invoking it", () => {
  const root = temporaryRoot();
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "vibe"), "#!/bin/sh\nexit 99\n");
  chmodSync(join(bin, "vibe"), 0o700);
  const env = { ...environment(root), PATH: bin };
  mkdirSync(env.HOME!, { recursive: true });
  assert.deepEqual(detectConfiguredAgentSkillTargets(env).map(({ target }) => target), ["vibe"]);
});

test("detects Antigravity from PATH as agy without invoking the CLI", () => {
  const root = temporaryRoot();
  const bin = join(root, "bin");
  const invoked = join(root, "invoked");
  mkdirSync(bin);
  writeFileSync(join(bin, "agy"), `#!/bin/sh\ntouch "${invoked}"\nexit 99\n`);
  chmodSync(join(bin, "agy"), 0o700);
  const env = { ...environment(root), PATH: bin };
  mkdirSync(env.HOME!, { recursive: true });

  assert.deepEqual(detectConfiguredAgentSkillTargets(env).map(({ target }) => target), ["antigravity"]);
  assert.equal(existsSync(invoked), false);
});
