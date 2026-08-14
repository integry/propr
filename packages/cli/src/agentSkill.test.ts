import assert from "node:assert/strict";
import { chmodSync, cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { rmSync } from "node:fs";
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

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "propr-agent-skill-test-"));
  roots.push(root);
  return root;
}

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
  assert.equal(installAgentSkill("claude", { env, bundleDir: current }).action, "updated");

  const target = resolveAgentSkillLocations(["claude"], env)[0].path;
  writeFileSync(join(target, "SKILL.md"), "user changed this\n");
  const refused = installAgentSkill("claude", { env, bundleDir: current });
  assert.equal(refused.action, "refused");
  assert.equal(refused.state, "modified-managed");
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
  assert.equal(removeAgentSkill("opencode", { env, bundleDir: source }).action, "removed");
  assert.equal(inspectAgentSkills(["opencode"], { env, bundleDir: source })[0].state, "absent");

  const target = resolveAgentSkillLocations(["opencode"], env)[0].path;
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "SKILL.md"), "foreign\n");
  assert.equal(removeAgentSkill("opencode", { env, bundleDir: source }).action, "refused");
  const forced = removeAgentSkill("opencode", { env, bundleDir: source, force: true });
  assert.equal(forced.action, "backed-up");
  assert.ok(forced.backupPath);
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
