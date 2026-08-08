import assert from "node:assert/strict";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { scaffoldStack } from "./initStack.js";

function mode(targetPath: string): number {
  return lstatSync(targetPath).mode & 0o777;
}

test("stack scaffolding tightens existing secrets and local state directories", async () => {
  if (process.platform === "win32") return;
  const root = mkdtempSync(join(tmpdir(), "propr-private-stack-"));
  try {
    writeFileSync(join(root, ".env"), "SESSION_SECRET=secret\n", { mode: 0o644 });
    for (const subdir of ["data", "logs", "repos"]) {
      mkdirSync(join(root, subdir), { mode: 0o755 });
    }
    let persistedRoot: string | undefined;
    const result = await scaffoldStack(
      { root },
      { persistStackRoot: async value => { persistedRoot = value; } },
    );

    assert.equal(result.envSkipped, true);
    assert.equal(persistedRoot, root);
    assert.equal(mode(root), 0o700);
    assert.equal(mode(join(root, ".env")), 0o600);
    for (const subdir of ["data", "logs", "repos"]) {
      assert.equal(mode(join(root, subdir)), 0o700);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stack scaffolding does not change the chosen project root mode", async () => {
  if (process.platform === "win32") return;
  const root = mkdtempSync(join(tmpdir(), "propr-private-stack-"));
  try {
    chmodSync(root, 0o755);
    writeFileSync(join(root, ".env"), "SESSION_SECRET=secret\n", { mode: 0o600 });
    await scaffoldStack({ root }, { persistStackRoot: async () => undefined });

    assert.equal(mode(root), 0o755);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stack scaffolding rejects symlinked secrets and state directories", async () => {
  if (process.platform === "win32") return;
  const root = mkdtempSync(join(tmpdir(), "propr-private-stack-"));
  const external = mkdtempSync(join(tmpdir(), "propr-private-stack-external-"));
  try {
    writeFileSync(join(external, "env"), "SESSION_SECRET=secret\n");
    symlinkSync(join(external, "env"), join(root, ".env"));
    await assert.rejects(
      scaffoldStack({ root }, { persistStackRoot: async () => undefined }),
      /symbolic-link file/,
    );

    rmSync(join(root, ".env"));
    rmSync(join(root, "data"), { recursive: true });
    symlinkSync(external, join(root, "data"));
    await assert.rejects(
      scaffoldStack({ root }, { persistStackRoot: async () => undefined }),
      /symbolic-link directory/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});
