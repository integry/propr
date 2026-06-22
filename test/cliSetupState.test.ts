import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  applyEnvSelection,
  createSetupState,
  hasEnvValue,
  inspectStackInit,
  isSetupComplete,
  isStackInitialized,
  nextPendingStep,
  readEnvVars,
  updateStep,
  STACK_SUBDIRS,
} from "../packages/cli/src/commands/setup/state.js";
import type { SetupState } from "../packages/cli/src/commands/setup/types.js";

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), "propr-setup-"));
}

function writeEnv(rootDir: string, contents: string): void {
  writeFileSync(join(rootDir, ".env"), contents, "utf-8");
}

test("readEnvVars returns {} when .env is absent", () => {
  assert.deepEqual(readEnvVars(makeRoot()), {});
});

test("readEnvVars returns {} when .env is a directory instead of a file", () => {
  const root = makeRoot();
  mkdirSync(join(root, ".env"));
  // Must not throw — a non-regular-file .env reads as "no vars", matching
  // inspectStackInit's isFile guard.
  assert.deepEqual(readEnvVars(root), {});
});

test("readEnvVars parses plain, exported, quoted, and commented assignments", () => {
  const root = makeRoot();
  writeEnv(
    root,
    [
      "# a comment line",
      "",
      "PLAIN=value",
      "export EXPORTED=exported-value",
      'DOUBLE="quoted value"',
      "SINGLE='single quoted'",
      "SPACED  =  spaced-value",
      "WITH_COMMENT=bare # trailing comment",
      'QUOTED_HASH="keep # this"',
      "not a valid line",
    ].join("\n"),
  );

  assert.deepEqual(readEnvVars(root), {
    PLAIN: "value",
    EXPORTED: "exported-value",
    DOUBLE: "quoted value",
    SINGLE: "single quoted",
    SPACED: "spaced-value",
    WITH_COMMENT: "bare",
    QUOTED_HASH: "keep # this",
  });
});

test("hasEnvValue is true only for present non-blank keys", () => {
  const root = makeRoot();
  writeEnv(root, "SET=value\nEMPTY=\nBLANK=   \n");
  assert.equal(hasEnvValue(root, "SET"), true);
  assert.equal(hasEnvValue(root, "EMPTY"), false);
  assert.equal(hasEnvValue(root, "BLANK"), false);
  assert.equal(hasEnvValue(root, "MISSING"), false);
});

test("applyEnvSelection writes only absent keys by default and reports skips", () => {
  const root = makeRoot();
  writeEnv(root, "EXISTING=old\n");

  const result = applyEnvSelection(root, { EXISTING: "new", FRESH: "added" });

  assert.deepEqual(result.written, ["FRESH"]);
  assert.deepEqual(result.skipped, ["EXISTING"]);
  const vars = readEnvVars(root);
  assert.equal(vars.EXISTING, "old");
  assert.equal(vars.FRESH, "added");
});

test("applyEnvSelection overwrites existing values when overwrite is set", () => {
  const root = makeRoot();
  writeEnv(root, "EXISTING=old\n");

  const result = applyEnvSelection(root, { EXISTING: "new" }, { overwrite: true });

  assert.deepEqual(result.written, ["EXISTING"]);
  assert.deepEqual(result.skipped, []);
  assert.equal(readEnvVars(root).EXISTING, "new");
});

test("applyEnvSelection treats a blank existing value as overwritable", () => {
  const root = makeRoot();
  writeEnv(root, "EMPTY=\n");

  const result = applyEnvSelection(root, { EMPTY: "filled" });

  assert.deepEqual(result.written, ["EMPTY"]);
  assert.equal(readEnvVars(root).EMPTY, "filled");
});

test("applyEnvSelection ignores blank selections so it never clobbers a value", () => {
  const root = makeRoot();
  writeEnv(root, "KEEP=value\n");

  const result = applyEnvSelection(root, { KEEP: "   ", OTHER: "" }, { overwrite: true });

  assert.deepEqual(result.written, []);
  assert.deepEqual(result.skipped, []);
  assert.equal(readEnvVars(root).KEEP, "value");
});

test("inspectStackInit requires .env as a file and every subdir as a directory", () => {
  const root = makeRoot();
  assert.equal(inspectStackInit(root).initialized, false);

  writeEnv(root, "X=1\n");
  for (const sub of STACK_SUBDIRS) mkdirSync(join(root, sub));

  const state = inspectStackInit(root);
  assert.equal(state.envExists, true);
  assert.equal(state.initialized, true);
  assert.equal(isStackInitialized(root), true);
});

test("inspectStackInit rejects a file standing in for an expected directory", () => {
  const root = makeRoot();
  writeEnv(root, "X=1\n");
  // One expected subdir slot is a regular file instead of a directory.
  writeFileSync(join(root, STACK_SUBDIRS[0]), "not a dir", "utf-8");
  for (const sub of STACK_SUBDIRS.slice(1)) mkdirSync(join(root, sub));

  const state = inspectStackInit(root);
  assert.equal(state.dirs[STACK_SUBDIRS[0]], false);
  assert.equal(state.initialized, false);
});

test("createSetupState starts every step pending", () => {
  const state = createSetupState("/tmp/root");
  assert.equal(state.rootDir, "/tmp/root");
  assert.ok(state.steps.length > 0);
  assert.ok(state.steps.every((step) => step.status === "pending"));
});

test("updateStep is immutable and patches by id", () => {
  const state = createSetupState("/tmp/root");
  const next = updateStep(state, "check", { status: "done", detail: "ok" });

  assert.notEqual(next, state);
  assert.equal(state.steps[0].status, "pending"); // original untouched
  const checkStep = next.steps.find((s) => s.id === "check");
  assert.equal(checkStep?.status, "done");
  assert.equal(checkStep?.detail, "ok");
});

test("updateStep returns the same reference for an unknown id", () => {
  const state = createSetupState("/tmp/root");
  // @ts-expect-error — exercising the unknown-id guard at runtime.
  const next = updateStep(state, "does-not-exist", { status: "done" });
  assert.equal(next, state);
});

test("nextPendingStep returns the first pending step", () => {
  const state = createSetupState("/tmp/root");
  const done = updateStep(state, state.steps[0].id, { status: "done" });
  assert.equal(nextPendingStep(done)?.id, state.steps[1].id);
});

test("nextPendingStep returns undefined when all steps are terminal", () => {
  let state = createSetupState("/tmp/root");
  for (const step of state.steps) state = updateStep(state, step.id, { status: "done" });
  assert.equal(nextPendingStep(state), undefined);
});

test("nextPendingStep blocks on a failed required step even when patched out of order", () => {
  const state = createSetupState("/tmp/root");
  // Fail a required step that comes *after* still-pending earlier steps.
  const laterRequired = state.steps.find((s) => !s.optional && s.id !== state.steps[0].id);
  assert.ok(laterRequired);
  const blocked = updateStep(state, laterRequired.id, { status: "failed" });
  assert.equal(nextPendingStep(blocked), undefined);
});

test("nextPendingStep is not blocked by a failed optional step", () => {
  const state = createSetupState("/tmp/root");
  const optional = state.steps.find((s) => s.optional);
  assert.ok(optional);
  const withFailedOptional = updateStep(state, optional.id, { status: "failed" });
  assert.equal(nextPendingStep(withFailedOptional)?.id, state.steps[0].id);
});

test("isSetupComplete requires every required step terminal and non-failed", () => {
  let state: SetupState = createSetupState("/tmp/root");
  assert.equal(isSetupComplete(state), false);

  for (const step of state.steps) {
    if (step.optional) continue; // leave optional steps pending
    state = updateStep(state, step.id, { status: "done" });
  }
  // Optional steps still pending must not block completion.
  assert.equal(isSetupComplete(state), true);
});

test("isSetupComplete treats skipped and warning required steps as complete", () => {
  let state: SetupState = createSetupState("/tmp/root");
  const required = state.steps.filter((s) => !s.optional);
  state = updateStep(state, required[0].id, { status: "skipped" });
  state = updateStep(state, required[1].id, { status: "warning" });
  for (const step of required.slice(2)) state = updateStep(state, step.id, { status: "done" });
  assert.equal(isSetupComplete(state), true);
});

test("isSetupComplete is false while any required step has failed", () => {
  let state: SetupState = createSetupState("/tmp/root");
  for (const step of state.steps) {
    if (!step.optional) state = updateStep(state, step.id, { status: "done" });
  }
  const required = state.steps.find((s) => !s.optional);
  assert.ok(required);
  state = updateStep(state, required.id, { status: "failed" });
  assert.equal(isSetupComplete(state), false);
});
