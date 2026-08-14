import assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  setNativeDirectoryOperationTestHook,
  type NativeDirectoryOperationTestEvent,
} from "./utils/directoryDescriptor.js";

function injectAtDarwinNativeBoundary(
  t: TestContext,
  inject: (event: NativeDirectoryOperationTestEvent) => void
): void {
  if (process.platform !== "darwin") return;
  setNativeDirectoryOperationTestHook(inject);
  t.after(() => setNativeDirectoryOperationTestHook());
}

function snapshotTree(path: string): Array<[string, string | Buffer]> {
  const entries: Array<[string, string | Buffer]> = [];
  const visit = (directory: string, prefix = ""): void => {
    for (const name of fs.readdirSync(directory).sort()) {
      const relativePath = prefix ? `${prefix}/${name}` : name;
      const fullPath = join(directory, name);
      const stat = fs.lstatSync(fullPath);
      if (stat.isDirectory()) {
        entries.push([relativePath, "directory"]);
        visit(fullPath, relativePath);
      } else {
        entries.push([relativePath, fs.readFileSync(fullPath)]);
      }
    }
  };
  visit(path);
  return entries;
}

function temporaryRoot(t: TestContext, prefix: string): string {
  // Resolve macOS's /var -> /private/var tmpdir alias without weakening the
  // production ancestor-symlink checks exercised by these fixtures.
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), prefix)));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

async function assertParentCreationSymlinkRace(t: TestContext, force: boolean): Promise<void> {
  const root = temporaryRoot(t, `propr-agent-skill-parent-race-${force ? "force" : "normal"}-`);
  const checkedAncestor = join(root, "provider-parent");
  const detachedAncestor = join(root, "detached-provider-parent");
  const env = {
    HOME: join(root, "home"),
    CODEX_HOME: join(checkedAncestor, "codex-home"),
  };
  fs.mkdirSync(env.HOME);
  fs.mkdirSync(checkedAncestor);
  const source = join(root, "bundle");
  fs.mkdirSync(join(source, "agents"), { recursive: true });
  fs.writeFileSync(join(source, "SKILL.md"), "---\nname: propr\ndescription: current skill\n---\n\n# ProPR\n");
  fs.writeFileSync(join(source, "agents", "openai.yaml"), "interface:\n  display_name: ProPR Operator\n");

  const outside = join(root, "outside");
  const outsideSentinel = join(outside, "sentinel.bin");
  const existingTarget = join(outside, "existing-target");
  const existingBackup = join(outside, "existing-backup");
  fs.mkdirSync(existingTarget, { recursive: true });
  fs.mkdirSync(existingBackup);
  fs.writeFileSync(outsideSentinel, Buffer.from([0x00, 0xff, 0x51, 0x9a]));
  fs.writeFileSync(join(existingTarget, "SKILL.md"), "existing target\n");
  fs.writeFileSync(join(existingBackup, "SKILL.md"), "existing backup\n");
  const outsideBefore = snapshotTree(outside);
  const sentinelBefore = fs.readFileSync(outsideSentinel);
  const missingDescendant = join(checkedAncestor, "codex-home");
  let injected = false;

  injectAtDarwinNativeBoundary(t, (event) => {
    if (!injected && event.operation === "mkdirAt" && event.phase === "before" && event.name === basename(missingDescendant)) {
      injected = true;
      fs.renameSync(checkedAncestor, detachedAncestor);
      fs.symlinkSync(outside, checkedAncestor, "dir");
    }
  });

  t.mock.module("node:fs", {
    namedExports: {
      ...fs,
      mkdirSync(path: fs.PathLike, options?: fs.MakeDirectoryOptions & { recursive?: boolean }): string | undefined {
        if (!injected && basename(String(path)) === basename(missingDescendant)) {
          injected = true;
          fs.renameSync(checkedAncestor, detachedAncestor);
          fs.symlinkSync(outside, checkedAncestor, "dir");
        }
        return fs.mkdirSync(path, options as fs.MakeDirectoryOptions & { recursive: true });
      },
    },
  });
  const agentSkillModule = new URL(`./agentSkill.ts?parent-symlink-race-${force ? "force" : "normal"}`, import.meta.url);
  const { installAgentSkill } = await import(agentSkillModule.href);

  const result = installAgentSkill("codex", {
    env,
    bundleDir: source,
    force,
    now: new Date("2026-08-14T10:24:00Z"),
  });

  assert.equal(injected, true);
  assert.equal(result.action, "failed");
  assert.match(result.detail ?? "", /symbolic link parent is not allowed|directory changed/);
  assert.deepEqual(snapshotTree(outside), outsideBefore);
  assert.deepEqual(fs.readFileSync(outsideSentinel), sentinelBefore);
  assert.equal(fs.readFileSync(join(existingTarget, "SKILL.md"), "utf8"), "existing target\n");
  assert.equal(fs.readFileSync(join(existingBackup, "SKILL.md"), "utf8"), "existing backup\n");
}

test("non-forced install refuses an already-checked ancestor replaced before descendant creation", async (t) => {
  await assertParentCreationSymlinkRace(t, false);
});

test("forced install refuses an already-checked ancestor replaced before descendant creation", async (t) => {
  await assertParentCreationSymlinkRace(t, true);
});

test("created-child cleanup preserves a replacement swapped after identity match", async (t) => {
  const root = temporaryRoot(t, "propr-agent-skill-created-child-race-test-");
  const env = {
    HOME: join(root, "home"),
    CODEX_HOME: join(root, "provider-parent", "codex-home"),
  };
  fs.mkdirSync(env.HOME, { recursive: true });
  fs.mkdirSync(dirname(env.CODEX_HOME), { recursive: true });
  const source = join(root, "bundle");
  fs.mkdirSync(join(source, "agents"), { recursive: true });
  fs.writeFileSync(join(source, "SKILL.md"), "---\nname: propr\ndescription: current skill\n---\n\n# ProPR\n");
  fs.writeFileSync(join(source, "agents", "openai.yaml"), "interface:\n  display_name: ProPR Operator\n");

  const createdChild = env.CODEX_HOME;
  const detachedChild = join(root, "detached-codex-home");
  const sentinel = join(createdChild, "provider-sentinel.bin");
  const sentinelContent = Buffer.from([0x00, 0xff, 0x51, 0x9a]);
  let injected = false;
  let matchedFd: number | undefined;
  let armed = false;
  let nameDeletionAttempted = false;
  let replacementBefore: Array<[string, string | Buffer]> | undefined;

  t.mock.module("node:fs", {
    namedExports: {
      ...fs,
      fstatSync(fd: number, options?: fs.StatOptions): fs.Stats | fs.BigIntStats {
        const status = fs.fstatSync(fd, options as never);
        if (!injected && fs.existsSync(createdChild)) {
          const visible = fs.lstatSync(createdChild);
          if (Number(status.dev) === visible.dev && Number(status.ino) === visible.ino) {
            matchedFd = fd;
            armed = true;
          }
        }
        return status;
      },
      closeSync(fd: number): void {
        if (!injected && armed && fd !== matchedFd && fs.existsSync(createdChild)) {
          injected = true;
          fs.renameSync(createdChild, detachedChild);
          fs.mkdirSync(createdChild);
          fs.writeFileSync(sentinel, sentinelContent);
          replacementBefore = snapshotTree(createdChild);
        }
        fs.closeSync(fd);
      },
      rmSync(path: fs.PathLike, options?: fs.RmDirOptions): void {
        if (String(path) === createdChild || String(path).includes(createdChild)) nameDeletionAttempted = true;
        fs.rmSync(path, options);
      },
    },
  });
  const agentSkillModule = new URL("./agentSkill.ts?created-child-directory-race", import.meta.url);
  const { installAgentSkill } = await import(agentSkillModule.href);

  const result = installAgentSkill("codex", { env, bundleDir: source });

  assert.equal(injected, true);
  assert.equal(result.action, "failed");
  assert.match(result.detail ?? "", /directory changed/);
  assert.equal(nameDeletionAttempted, false);
  assert.equal(fs.lstatSync(createdChild).isDirectory(), true);
  assert.deepEqual(fs.readFileSync(sentinel), sentinelContent);
  assert.ok(replacementBefore);
  assert.deepEqual(snapshotTree(createdChild), replacementBefore);
  assert.equal(fs.lstatSync(detachedChild).isDirectory(), true);
});

test("post-identity publication substitution has no staging name-delete cleanup", async (t) => {
  const root = temporaryRoot(t, "propr-agent-skill-staging-cleanup-race-test-");
  const env = { HOME: join(root, "home"), CODEX_HOME: join(root, "codex-home") };
  fs.mkdirSync(env.HOME, { recursive: true });
  const source = join(root, "bundle");
  fs.mkdirSync(join(source, "agents"), { recursive: true });
  fs.writeFileSync(join(source, "SKILL.md"), "---\nname: propr\ndescription: current skill\n---\n\n# ProPR\n");
  fs.writeFileSync(join(source, "agents", "openai.yaml"), "interface:\n  display_name: ProPR Operator\n");

  const skillsParent = join(env.CODEX_HOME, "skills");
  const target = join(skillsParent, "propr");
  const detachedTarget = join(root, "detached-target");
  const sentinel = join(target, "provider-sentinel.bin");
  const sentinelContent = Buffer.from([0x00, 0xff, 0x51, 0x9a]);
  let injected = false;
  let targetIdentityMatches = 0;
  let stagingCreated = false;
  let nameDeletionAttempted = false;
  let replacementBefore: Array<[string, string | Buffer]> | undefined;

  injectAtDarwinNativeBoundary(t, (event) => {
    if (!injected && targetIdentityMatches >= 2 && event.operation === "mkdirAt" && event.phase === "before" && event.name === "agents") {
      injected = true;
      fs.renameSync(target, detachedTarget);
      fs.mkdirSync(target);
      fs.writeFileSync(sentinel, sentinelContent);
      replacementBefore = snapshotTree(target);
    }
  });

  t.mock.module("node:fs", {
    namedExports: {
      ...fs,
      fstatSync(fd: number, options?: fs.StatOptions): fs.Stats | fs.BigIntStats {
        const status = fs.fstatSync(fd, options as never);
        if (fs.existsSync(target)) {
          const visible = fs.lstatSync(target);
          if (Number(status.dev) === visible.dev && Number(status.ino) === visible.ino) targetIdentityMatches += 1;
        }
        return status;
      },
      mkdirSync(path: fs.PathLike, options?: fs.MakeDirectoryOptions & { recursive?: boolean }): string | undefined {
        const name = basename(String(path));
        if (name.startsWith(".propr.installing-")) stagingCreated = true;
        if (!injected && targetIdentityMatches >= 2 && name === "agents") {
          injected = true;
          fs.renameSync(target, detachedTarget);
          fs.mkdirSync(target);
          fs.writeFileSync(sentinel, sentinelContent);
          replacementBefore = snapshotTree(target);
        }
        return fs.mkdirSync(path, options as fs.MakeDirectoryOptions & { recursive: true });
      },
      rmSync(path: fs.PathLike, options?: fs.RmDirOptions): void {
        if (String(path) === target || String(path).includes(".propr.installing-")) nameDeletionAttempted = true;
        fs.rmSync(path, options);
      },
    },
  });
  const agentSkillModule = new URL("./agentSkill.ts?staging-cleanup-directory-race", import.meta.url);
  const { installAgentSkill } = await import(agentSkillModule.href);

  const result = installAgentSkill("codex", {
    env,
    bundleDir: source,
    now: new Date("2026-08-14T10:24:00Z"),
  });

  assert.equal(injected, true);
  assert.equal(result.action, "failed");
  assert.equal(stagingCreated, false);
  assert.equal(nameDeletionAttempted, false);
  assert.equal(fs.lstatSync(target).isDirectory(), true);
  assert.deepEqual(fs.readFileSync(sentinel), sentinelContent);
  assert.ok(replacementBefore);
  assert.deepEqual(snapshotTree(target), replacementBefore);
  assert.equal(fs.lstatSync(detachedTarget).isDirectory(), true);
  assert.equal(fs.readFileSync(join(detachedTarget, "SKILL.md"), "utf8").includes("current skill"), true);
});

test("non-forced claim preserves a target created after the absence inspection", async (t) => {
  const root = temporaryRoot(t, "propr-agent-skill-concurrent-claim-test-");
  const env = { HOME: join(root, "home"), CODEX_HOME: join(root, "codex-home") };
  fs.mkdirSync(env.HOME, { recursive: true });
  const source = join(root, "bundle");
  fs.mkdirSync(join(source, "agents"), { recursive: true });
  fs.writeFileSync(join(source, "SKILL.md"), "---\nname: propr\ndescription: current skill\n---\n\n# ProPR\n");
  fs.writeFileSync(join(source, "agents", "openai.yaml"), "interface:\n  display_name: ProPR Operator\n");

  const target = join(env.CODEX_HOME, "skills", "propr");
  const sentinelContent = Buffer.from([0x00, 0xff, 0x51, 0x9a]);
  let injected = false;
  let replacementBefore: Array<[string, string | Buffer]> | undefined;
  injectAtDarwinNativeBoundary(t, (event) => {
    if (!injected && event.operation === "mkdirAt" && event.phase === "before" && event.name === "propr") {
      injected = true;
      fs.mkdirSync(target);
      fs.writeFileSync(join(target, "sentinel.bin"), sentinelContent);
      replacementBefore = snapshotTree(target);
    }
  });
  t.mock.module("node:fs", {
    namedExports: {
      ...fs,
      mkdirSync(path: fs.PathLike, options?: fs.MakeDirectoryOptions & { recursive?: boolean }): string | undefined {
        if (!injected && basename(String(path)) === "propr") {
          injected = true;
          fs.mkdirSync(target);
          fs.writeFileSync(join(target, "sentinel.bin"), sentinelContent);
          replacementBefore = snapshotTree(target);
        }
        return fs.mkdirSync(path, options as fs.MakeDirectoryOptions & { recursive: true });
      },
    },
  });
  const agentSkillModule = new URL("./agentSkill.ts?concurrent-target-claim", import.meta.url);
  const { installAgentSkill } = await import(agentSkillModule.href);

  const result = installAgentSkill("codex", { env, bundleDir: source });

  assert.equal(injected, true);
  assert.equal(result.action, "failed");
  assert.match(result.detail ?? "", /created during installation and was not overwritten/);
  assert.deepEqual(fs.readFileSync(join(target, "sentinel.bin")), sentinelContent);
  assert.ok(replacementBefore);
  assert.deepEqual(snapshotTree(target), replacementBefore);
});

test("adoption publishes only to the held tree after outside-symlink substitution", async (t) => {
  const root = temporaryRoot(t, "propr-agent-skill-adoption-target-race-test-");
  const env = { HOME: join(root, "home"), CODEX_HOME: join(root, "codex-home") };
  fs.mkdirSync(env.HOME, { recursive: true });
  const source = join(root, "bundle");
  fs.mkdirSync(join(source, "agents"), { recursive: true });
  fs.writeFileSync(join(source, "SKILL.md"), "---\nname: propr\ndescription: current skill\n---\n\n# ProPR\n");
  fs.writeFileSync(join(source, "agents", "openai.yaml"), "interface:\n  display_name: ProPR Operator\n");

  const target = join(env.CODEX_HOME, "skills", "propr");
  fs.mkdirSync(dirname(target), { recursive: true });
  fs.cpSync(source, target, { recursive: true });
  const targetBefore = snapshotTree(target);
  const detachedTarget = join(root, "detached-target");
  const outside = join(root, "outside");
  fs.mkdirSync(outside);
  fs.writeFileSync(join(outside, "sentinel.bin"), Buffer.from([0x00, 0xff, 0x51, 0x9a]));
  const outsideBefore = snapshotTree(outside);
  let injected = false;

  injectAtDarwinNativeBoundary(t, (event) => {
    if (!injected && event.operation === "openAt" && event.phase === "before" && event.name === ".propr-managed.json") {
      injected = true;
      fs.renameSync(target, detachedTarget);
      fs.symlinkSync(outside, target, "dir");
    }
  });

  t.mock.module("node:fs", {
    namedExports: {
      ...fs,
      writeFileSync(path: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, options?: fs.WriteFileOptions): void {
        if (!injected && basename(String(path)) === ".propr-managed.json") {
          injected = true;
          fs.renameSync(target, detachedTarget);
          fs.symlinkSync(outside, target, "dir");
        }
        fs.writeFileSync(path, data, options);
      },
    },
  });
  const agentSkillModule = new URL("./agentSkill.ts?adoption-target-symlink-race", import.meta.url);
  const { installAgentSkill } = await import(agentSkillModule.href);

  const result = installAgentSkill("codex", { env, bundleDir: source });

  assert.equal(injected, true);
  assert.equal(result.action, "failed");
  assert.match(result.detail ?? "", /symbolic link parent is not allowed|directory changed|target changed during adoption/);
  assert.equal(fs.lstatSync(target).isSymbolicLink(), true);
  assert.deepEqual(snapshotTree(outside), outsideBefore);
  assert.deepEqual(snapshotTree(detachedTarget).filter(([path]) => path !== ".propr-managed.json"), targetBefore);
  assert.equal(fs.lstatSync(join(detachedTarget, ".propr-managed.json")).isFile(), true);
});

test("forced backup rename cannot follow a replaced skills parent", async (t) => {
  const root = temporaryRoot(t, "propr-agent-skill-backup-parent-race-test-");
  const env = { HOME: join(root, "home"), CODEX_HOME: join(root, "codex-home") };
  fs.mkdirSync(env.HOME, { recursive: true });
  const source = join(root, "bundle");
  fs.mkdirSync(join(source, "agents"), { recursive: true });
  fs.writeFileSync(join(source, "SKILL.md"), "---\nname: propr\ndescription: current skill\n---\n\n# ProPR\n");
  fs.writeFileSync(join(source, "agents", "openai.yaml"), "interface:\n  display_name: ProPR Operator\n");

  const skillsParent = join(env.CODEX_HOME, "skills");
  const target = join(skillsParent, "propr");
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(join(target, "SKILL.md"), "foreign\n");
  const detachedParent = join(env.CODEX_HOME, "detached-skills");
  const outside = join(root, "outside");
  fs.mkdirSync(join(outside, "propr"), { recursive: true });
  fs.writeFileSync(join(outside, "propr", "sentinel.bin"), Buffer.from([0x00, 0xff, 0x51, 0x9a]));
  const outsideBefore = snapshotTree(outside);
  let injected = false;

  injectAtDarwinNativeBoundary(t, (event) => {
    if (
      !injected &&
      event.operation === "renameAt" &&
      event.phase === "before" &&
      event.name === "propr" &&
      event.newName?.startsWith(".propr.backup-")
    ) {
      injected = true;
      fs.renameSync(skillsParent, detachedParent);
      fs.symlinkSync(outside, skillsParent, "dir");
    }
  });

  t.mock.module("node:fs", {
    namedExports: {
      ...fs,
      renameSync(oldPath: fs.PathLike, newPath: fs.PathLike): void {
        if (!injected && basename(String(oldPath)) === "propr" && basename(String(newPath)).startsWith(".propr.backup-")) {
          injected = true;
          fs.renameSync(skillsParent, detachedParent);
          fs.symlinkSync(outside, skillsParent, "dir");
        }
        fs.renameSync(oldPath, newPath);
      },
    },
  });
  const agentSkillModule = new URL("./agentSkill.ts?backup-parent-symlink-race", import.meta.url);
  const { installAgentSkill } = await import(agentSkillModule.href);
  const now = new Date("2026-08-14T10:24:00Z");

  const result = installAgentSkill("codex", { env, bundleDir: source, force: true, now });

  assert.equal(injected, true);
  assert.equal(result.action, "failed");
  assert.match(result.detail ?? "", /symbolic link parent is not allowed|directory changed/);
  assert.deepEqual(snapshotTree(outside), outsideBefore);
  assert.equal(fs.readFileSync(join(detachedParent, ".propr.backup-20260814102400000", "SKILL.md"), "utf8"), "foreign\n");
});

test("backup move preserves a destination created immediately before rename and retries", async (t) => {
  const root = temporaryRoot(t, "propr-agent-skill-backup-name-race-test-");
  const env = { HOME: join(root, "home"), CODEX_HOME: join(root, "codex-home") };
  fs.mkdirSync(env.HOME, { recursive: true });
  const source = join(root, "bundle");
  fs.mkdirSync(join(source, "agents"), { recursive: true });
  fs.writeFileSync(join(source, "SKILL.md"), "---\nname: propr\ndescription: current skill\n---\n\n# ProPR\n");
  fs.writeFileSync(join(source, "agents", "openai.yaml"), "interface:\n  display_name: ProPR Operator\n");

  const skillsParent = join(env.CODEX_HOME, "skills");
  const target = join(skillsParent, "propr");
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(join(target, "SKILL.md"), "foreign\n");
  const occupied = join(skillsParent, ".propr.backup-20260814102400000");
  let injected = false;

  injectAtDarwinNativeBoundary(t, (event) => {
    if (!injected && event.operation === "mkdirAt" && event.phase === "before" && event.name === basename(occupied)) {
      injected = true;
      fs.mkdirSync(occupied);
    }
  });

  t.mock.module("node:fs", {
    namedExports: {
      ...fs,
      mkdirSync(path: fs.PathLike, options?: fs.MakeDirectoryOptions & { recursive?: boolean }): string | undefined {
        if (!injected && basename(String(path)) === basename(occupied)) {
          injected = true;
          fs.mkdirSync(occupied);
        }
        return fs.mkdirSync(path, options as fs.MakeDirectoryOptions & { recursive: true });
      },
    },
  });
  const agentSkillModule = new URL("./agentSkill.ts?backup-name-race", import.meta.url);
  const { installAgentSkill } = await import(agentSkillModule.href);

  const result = installAgentSkill("codex", {
    env,
    bundleDir: source,
    force: true,
    now: new Date("2026-08-14T10:24:00Z"),
  });

  assert.equal(result.action, "backed-up");
  assert.equal(injected, true);
  assert.equal(result.backupPath, `${occupied}-1`);
  assert.deepEqual(fs.readdirSync(occupied), []);
  assert.equal(fs.readFileSync(join(result.backupPath!, "SKILL.md"), "utf8"), "foreign\n");
});

test("removal rename cannot follow a replaced skills parent", async (t) => {
  const root = temporaryRoot(t, "propr-agent-skill-removal-parent-race-test-");
  const env = { HOME: join(root, "home"), CODEX_HOME: join(root, "codex-home") };
  fs.mkdirSync(env.HOME, { recursive: true });
  const source = join(root, "bundle");
  fs.mkdirSync(join(source, "agents"), { recursive: true });
  fs.writeFileSync(join(source, "SKILL.md"), "---\nname: propr\ndescription: current skill\n---\n\n# ProPR\n");
  fs.writeFileSync(join(source, "agents", "openai.yaml"), "interface:\n  display_name: ProPR Operator\n");
  const setupModule = new URL("./agentSkill.ts?removal-parent-race-setup", import.meta.url);
  const { installAgentSkill: setupSkill } = await import(setupModule.href);
  assert.equal(setupSkill("codex", { env, bundleDir: source }).action, "installed");

  const skillsParent = join(env.CODEX_HOME, "skills");
  const detachedParent = join(env.CODEX_HOME, "detached-skills");
  const outside = join(root, "outside");
  fs.mkdirSync(join(outside, "propr"), { recursive: true });
  fs.writeFileSync(join(outside, "propr", "sentinel.bin"), Buffer.from([0x00, 0xff, 0x51, 0x9a]));
  const outsideBefore = snapshotTree(outside);
  let injected = false;

  injectAtDarwinNativeBoundary(t, (event) => {
    if (
      !injected &&
      event.operation === "renameAt" &&
      event.phase === "before" &&
      event.name === "propr" &&
      event.newName?.startsWith(".propr.removing-")
    ) {
      injected = true;
      fs.renameSync(skillsParent, detachedParent);
      fs.symlinkSync(outside, skillsParent, "dir");
    }
  });

  t.mock.module("node:fs", {
    namedExports: {
      ...fs,
      renameSync(oldPath: fs.PathLike, newPath: fs.PathLike): void {
        if (!injected && basename(String(oldPath)) === "propr" && basename(String(newPath)).startsWith(".propr.removing-")) {
          injected = true;
          fs.renameSync(skillsParent, detachedParent);
          fs.symlinkSync(outside, skillsParent, "dir");
        }
        fs.renameSync(oldPath, newPath);
      },
    },
  });
  const agentSkillModule = new URL("./agentSkill.ts?removal-parent-symlink-race", import.meta.url);
  const { removeAgentSkill } = await import(agentSkillModule.href);
  const now = new Date("2026-08-14T10:24:00Z");

  const result = removeAgentSkill("codex", { env, bundleDir: source, now });

  assert.equal(injected, true);
  assert.equal(result.action, "failed");
  assert.match(result.detail ?? "", /symbolic link parent is not allowed|directory changed/);
  assert.deepEqual(snapshotTree(outside), outsideBefore);
  assert.ok(fs.existsSync(join(detachedParent, ".propr.removing-20260814102400000", "SKILL.md")));
});

test("forced install fails and preserves both trees when the published bundle is modified before final inspection", async (t) => {
  const root = temporaryRoot(t, "propr-agent-skill-force-race-test-");
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
  fs.writeFileSync(join(target, "sentinel.bin"), Buffer.from([0x00, 0xff, 0x51, 0x9a]));
  const originalBefore = snapshotTree(target);
  const unrelated = join(root, "unrelated");
  fs.mkdirSync(unrelated);
  fs.writeFileSync(join(unrelated, "sentinel.bin"), Buffer.from([0x73, 0x11, 0x00, 0xff]));
  const unrelatedBefore = snapshotTree(unrelated);

  const renames: Array<[fs.PathLike, fs.PathLike]> = [];
  let injected = false;
  injectAtDarwinNativeBoundary(t, (event) => {
    if (event.operation === "renameAt" && event.phase === "before") {
      renames.push([event.name, event.newName!]);
    }
    if (!injected && event.operation === "openAt" && event.phase === "after" && event.name === ".propr-managed.json") {
      injected = true;
      fs.writeFileSync(join(target, "SKILL.md"), "modified concurrently\n");
    }
  });
  t.mock.module("node:fs", {
    namedExports: {
      ...fs,
      renameSync(oldPath: fs.PathLike, newPath: fs.PathLike): void {
        renames.push([oldPath, newPath]);
        fs.renameSync(oldPath, newPath);
      },
      writeFileSync(path: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, options?: fs.WriteFileOptions): void {
        fs.writeFileSync(path, data, options);
        if (basename(String(path)) === ".propr-managed.json") {
          injected = true;
          fs.writeFileSync(join(target, "SKILL.md"), "modified concurrently\n");
        }
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

  assert.equal(injected, true);
  assert.deepEqual(renames.map(([, newPath]) => basename(String(newPath))), [basename(result.backupPath!)]);
  assert.equal(result.action, "failed");
  assert.equal(result.state, "modified-managed");
  assert.match(result.detail ?? "", /changed after the new bundle was published and was preserved/);
  assert.ok(result.backupPath);
  assert.equal(fs.readFileSync(join(target, "SKILL.md"), "utf8"), "modified concurrently\n");
  assert.deepEqual(snapshotTree(result.backupPath!), originalBefore);
  assert.deepEqual(snapshotTree(unrelated), unrelatedBefore);
});

test("publication cannot follow a target replaced by an outside symlink after the final safety check", async (t) => {
  const root = temporaryRoot(t, "propr-agent-skill-target-publish-race-test-");
  const env = { HOME: join(root, "home"), CODEX_HOME: join(root, "codex-home") };
  fs.mkdirSync(env.HOME, { recursive: true });
  const source = join(root, "bundle");
  fs.mkdirSync(join(source, "agents"), { recursive: true });
  fs.writeFileSync(join(source, "SKILL.md"), "---\nname: propr\ndescription: current skill\n---\n\n# ProPR\n");
  fs.writeFileSync(join(source, "agents", "openai.yaml"), "interface:\n  display_name: ProPR Operator\n");

  const target = join(env.CODEX_HOME, "skills", "propr");
  const outside = join(root, "outside");
  fs.mkdirSync(outside);
  fs.writeFileSync(join(outside, "sentinel.bin"), Buffer.from([0x00, 0xff, 0x51, 0x9a]));
  const outsideBefore = snapshotTree(outside);
  let targetClaimed = false;
  let injected = false;

  injectAtDarwinNativeBoundary(t, (event) => {
    if (event.operation !== "mkdirAt") return;
    if (!injected && targetClaimed && event.phase === "before") {
      injected = true;
      fs.rmSync(target, { recursive: true });
      fs.symlinkSync(outside, target, "dir");
    }
    if (event.phase === "after" && event.name === "propr") targetClaimed = true;
  });

  t.mock.module("node:fs", {
    namedExports: {
      ...fs,
      mkdirSync(path: fs.PathLike, options?: fs.MakeDirectoryOptions & { recursive?: boolean }): string | undefined {
        const value = String(path);
        if (!injected && targetClaimed) {
          injected = true;
          fs.rmSync(target, { recursive: true });
          fs.symlinkSync(outside, target, "dir");
        }
        const result = fs.mkdirSync(path, options as fs.MakeDirectoryOptions & { recursive: true });
        if (basename(value) === "propr") targetClaimed = true;
        return result;
      },
    },
  });
  const agentSkillModule = new URL("./agentSkill.ts?target-publication-symlink-race", import.meta.url);
  const { installAgentSkill } = await import(agentSkillModule.href);

  const result = installAgentSkill("codex", {
    env,
    bundleDir: source,
    now: new Date("2026-08-14T10:24:00Z"),
  });

  assert.equal(targetClaimed, true);
  assert.equal(injected, true);
  assert.equal(result.action, "failed");
  assert.equal(result.state, "unsafe");
  assert.match(result.detail ?? "", /installation stopped rather than overwrite content created concurrently/);
  assert.deepEqual(snapshotTree(outside), outsideBefore);
  assert.equal(fs.lstatSync(target).isSymbolicLink(), true);
});

test("forced install leaves a concurrent replacement untouched and reports the displaced original", async (t) => {
  const root = temporaryRoot(t, "propr-agent-skill-force-publish-race-test-");
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
  const replacementContent = Buffer.from([0x00, 0xff, 0x51, 0x9a]);
  let replacementBefore: Array<[string, string | Buffer]> | undefined;

  injectAtDarwinNativeBoundary(t, (event) => {
    if (event.operation === "renameAt" && event.phase === "after" && event.name === "propr") {
      fs.mkdirSync(target);
      fs.writeFileSync(join(target, "sentinel.bin"), replacementContent);
      replacementBefore = snapshotTree(target);
    }
  });

  t.mock.module("node:fs", {
    namedExports: {
      ...fs,
      renameSync(oldPath: fs.PathLike, newPath: fs.PathLike): void {
        fs.renameSync(oldPath, newPath);
        if (basename(String(oldPath)) === "propr") {
          fs.mkdirSync(target);
          fs.writeFileSync(join(target, "sentinel.bin"), replacementContent);
          replacementBefore = snapshotTree(target);
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
  assert.match(result.detail ?? "", /target was created during installation and was not overwritten/);
  assert.match(result.detail ?? "", /content preserved at/);
  assert.match(result.detail ?? "", new RegExp(result.backupPath!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(fs.readFileSync(join(result.backupPath!, "SKILL.md"), "utf8"), "foreign\n");
  assert.ok(replacementBefore);
  assert.deepEqual(snapshotTree(target), replacementBefore);
  assert.deepEqual(fs.readFileSync(join(target, "sentinel.bin")), replacementContent);
});

test("non-forced update preserves a detached tree changed after validation", async (t) => {
  const root = temporaryRoot(t, "propr-agent-skill-update-race-test-");
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
  const root = temporaryRoot(t, "propr-agent-skill-removal-race-test-");
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
