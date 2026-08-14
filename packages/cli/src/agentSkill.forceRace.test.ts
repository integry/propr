import assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

test("forced install fails and preserves both trees when the published bundle is modified before final inspection", async (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), "propr-agent-skill-force-race-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = {
    HOME: join(root, "home"),
    CODEX_HOME: join(root, "codex-home"),
    XDG_CONFIG_HOME: join(root, "xdg"),
  };
  fs.mkdirSync(env.HOME, { recursive: true });
  const source = join(root, "bundle");
  fs.mkdirSync(join(source, "agents"), { recursive: true });
  fs.writeFileSync(join(source, "SKILL.md"), "---\nname: propr\ndescription: current skill\n---\n\n# ProPR\n");
  fs.writeFileSync(join(source, "agents", "openai.yaml"), "interface:\n  display_name: ProPR Operator\n");
  const target = join(env.HOME, ".vibe", "skills", "propr");
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(join(target, "SKILL.md"), "foreign\n");

  const renames: Array<[fs.PathLike, fs.PathLike]> = [];
  t.mock.module("node:fs", {
    namedExports: {
      ...fs,
      renameSync(oldPath: fs.PathLike, newPath: fs.PathLike): void {
        renames.push([oldPath, newPath]);
        fs.renameSync(oldPath, newPath);
        if (newPath === target) fs.writeFileSync(join(target, "SKILL.md"), "modified concurrently\n");
      },
    },
  });
  const agentSkillModule = new URL("./agentSkill.ts", import.meta.url);
  const { installAgentSkill } = await import(agentSkillModule.href);

  const result = installAgentSkill("vibe", {
    env,
    bundleDir: source,
    force: true,
    now: new Date("2026-08-14T10:24:00Z"),
  });

  assert.deepEqual(renames.map(([, newPath]) => newPath), [result.backupPath, target]);
  assert.equal(result.action, "failed");
  assert.equal(result.state, "modified-managed");
  assert.match(result.detail ?? "", /changed after the new bundle was published and was preserved/);
  assert.ok(result.backupPath);
  assert.equal(fs.readFileSync(join(target, "SKILL.md"), "utf8"), "modified concurrently\n");
  assert.equal(fs.readFileSync(join(result.backupPath!, "SKILL.md"), "utf8"), "foreign\n");
});

test("forced install reports the displaced original when a concurrent non-empty target blocks publication", async (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), "propr-agent-skill-force-publish-race-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = {
    HOME: join(root, "home"),
    CODEX_HOME: join(root, "codex-home"),
    XDG_CONFIG_HOME: join(root, "xdg"),
  };
  fs.mkdirSync(env.HOME, { recursive: true });
  const source = join(root, "bundle");
  fs.mkdirSync(join(source, "agents"), { recursive: true });
  fs.writeFileSync(join(source, "SKILL.md"), "---\nname: propr\ndescription: current skill\n---\n\n# ProPR\n");
  fs.writeFileSync(join(source, "agents", "openai.yaml"), "interface:\n  display_name: ProPR Operator\n");
  const target = join(env.HOME, ".vibe", "skills", "propr");
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(join(target, "SKILL.md"), "foreign\n");

  t.mock.module("node:fs", {
    namedExports: {
      ...fs,
      renameSync(oldPath: fs.PathLike, newPath: fs.PathLike): void {
        fs.renameSync(oldPath, newPath);
        if (oldPath === target) {
          fs.mkdirSync(target);
          fs.writeFileSync(join(target, "concurrent.txt"), "created concurrently\n");
        }
      },
    },
  });
  const agentSkillModule = new URL("./agentSkill.ts?force-publish-race", import.meta.url);
  const { installAgentSkill } = await import(agentSkillModule.href);

  const result = installAgentSkill("vibe", {
    env,
    bundleDir: source,
    force: true,
    now: new Date("2026-08-14T10:24:00Z"),
  });

  assert.equal(result.action, "failed");
  assert.ok(result.backupPath);
  assert.match(result.detail ?? "", /original target remains preserved at/);
  assert.match(result.detail ?? "", new RegExp(result.backupPath!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(fs.readFileSync(join(result.backupPath!, "SKILL.md"), "utf8"), "foreign\n");
  assert.equal(fs.readFileSync(join(target, "concurrent.txt"), "utf8"), "created concurrently\n");
});

test("non-forced update preserves a detached tree changed after validation", async (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), "propr-agent-skill-update-race-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { HOME: join(root, "home"), CODEX_HOME: join(root, "codex-home") };
  fs.mkdirSync(env.HOME, { recursive: true });
  const older = join(root, "older");
  const current = join(root, "current");
  for (const [source, description] of [[older, "older skill"], [current, "current skill"]] as const) {
    fs.mkdirSync(join(source, "agents"), { recursive: true });
    fs.writeFileSync(join(source, "SKILL.md"), `---\nname: propr\ndescription: ${description}\n---\n\n# ProPR\n`);
    fs.writeFileSync(join(source, "agents", "openai.yaml"), "interface:\n  display_name: ProPR Operator\n");
  }

  let detachedReads = 0;
  t.mock.module("node:fs", {
    namedExports: {
      ...fs,
      readFileSync(path: fs.PathOrFileDescriptor, options?: unknown): string | Buffer {
        const content = fs.readFileSync(path, options as never);
        if (String(path).includes(".propr.replaced-") && String(path).endsWith("SKILL.md")) {
          detachedReads += 1;
          if (detachedReads === 2) fs.writeFileSync(join(dirname(String(path)), "concurrent.txt"), "changed concurrently\n");
        }
        return content;
      },
    },
  });
  const agentSkillModule = new URL("./agentSkill.ts?non-force-update-race", import.meta.url);
  const { installAgentSkill } = await import(agentSkillModule.href);
  assert.equal(installAgentSkill("codex", { env, bundleDir: older }).action, "installed");

  const result = installAgentSkill("codex", {
    env,
    bundleDir: current,
    now: new Date("2026-08-14T10:24:00Z"),
  });

  assert.equal(result.action, "updated");
  assert.ok(result.backupPath);
  assert.equal(fs.readFileSync(join(result.backupPath!, "concurrent.txt"), "utf8"), "changed concurrently\n");
});

test("non-forced removal preserves a detached tree changed after validation", async (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), "propr-agent-skill-removal-race-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { HOME: join(root, "home"), CODEX_HOME: join(root, "codex-home") };
  fs.mkdirSync(env.HOME, { recursive: true });
  const source = join(root, "bundle");
  fs.mkdirSync(join(source, "agents"), { recursive: true });
  fs.writeFileSync(join(source, "SKILL.md"), "---\nname: propr\ndescription: current skill\n---\n\n# ProPR\n");
  fs.writeFileSync(join(source, "agents", "openai.yaml"), "interface:\n  display_name: ProPR Operator\n");

  t.mock.module("node:fs", {
    namedExports: {
      ...fs,
      readFileSync(path: fs.PathOrFileDescriptor, options?: unknown): string | Buffer {
        const content = fs.readFileSync(path, options as never);
        if (String(path).includes(".propr.removing-") && String(path).endsWith("SKILL.md")) {
          fs.writeFileSync(join(dirname(String(path)), "concurrent.txt"), "changed concurrently\n");
        }
        return content;
      },
    },
  });
  const agentSkillModule = new URL("./agentSkill.ts?non-force-removal-race", import.meta.url);
  const { installAgentSkill, removeAgentSkill } = await import(agentSkillModule.href);
  assert.equal(installAgentSkill("codex", { env, bundleDir: source }).action, "installed");

  const result = removeAgentSkill("codex", {
    env,
    bundleDir: source,
    now: new Date("2026-08-14T10:24:00Z"),
  });

  assert.equal(result.action, "removed");
  assert.ok(result.backupPath);
  assert.equal(fs.readFileSync(join(result.backupPath!, "concurrent.txt"), "utf8"), "changed concurrently\n");
});
