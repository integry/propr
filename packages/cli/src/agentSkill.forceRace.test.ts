import assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
