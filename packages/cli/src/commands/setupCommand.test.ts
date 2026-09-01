/**
 * `propr setup` renderer-selection tests. Run with:
 * `npx tsx --test src/commands/setupCommand.test.ts` (from packages/cli).
 *
 * These pin the pure decision that routes between the Ink wizard and the
 * sequential readline fallback, without spinning up a terminal or either UI.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canRenderInkSetup,
  createSetupCommand,
  offerSetupAgentSkill,
  shouldPrepareInkGithubLogin,
} from "./setupCommand.js";
import type { AgentSkillOperationResult, AgentSkillTarget } from "../agentSkill.js";

const rawTty = { isTTY: true, setRawMode() {} };

test("canRenderInkSetup: true only when both streams are raw-mode TTYs", () => {
  assert.equal(canRenderInkSetup(rawTty, { isTTY: true }), true);
});

test("canRenderInkSetup: false when stdin is not a TTY (piped/redirected/CI)", () => {
  assert.equal(canRenderInkSetup({ isTTY: false, setRawMode() {} }, { isTTY: true }), false);
});

test("canRenderInkSetup: false when stdout is not a TTY", () => {
  assert.equal(canRenderInkSetup(rawTty, { isTTY: false }), false);
});

test("canRenderInkSetup: false when stdin cannot enter raw mode", () => {
  // A TTY without setRawMode (some SSH/embedded terminals) falls back to the
  // sequential readline wizard rather than a broken keyboard-driven view.
  assert.equal(canRenderInkSetup({ isTTY: true }, { isTTY: true }), false);
});

function installed(target: AgentSkillTarget): AgentSkillOperationResult {
  return {
    target,
    toolHome: `/tmp/${target}`,
    path: `/tmp/${target}/skills/propr`,
    state: "current-managed",
    bundledIdentity: "a".repeat(64),
    installedIdentity: "a".repeat(64),
    action: "installed",
  };
}

for (const action of ["failed", "refused"] as const) {
  for (const state of ["foreign", "modified-managed"] as const) {
    test(`setup recovery uses --force for a ${action} ${state} skill install`, async () => {
      const lines: string[] = [];
      await offerSetupAgentSkill({
        interactive: false,
        explicitTargets: "codex",
        env: { HOME: "/tmp/propr-recovery" },
        log: (line) => lines.push(line),
        install: (target) => ({ ...installed(target), action, state }),
      });

      assert.ok(lines.includes("  Recovery: propr skill install codex --force"));
    });
  }
}

test("guided setup prompts once, shows exact detected paths, and installs the selected detected tools", async () => {
  const lines: string[] = [];
  const questions: string[] = [];
  const installedTargets: AgentSkillTarget[] = [];
  const root = `/tmp/propr-setup-skill-${process.pid}`;
  const { mkdirSync, rmSync } = await import("node:fs");
  mkdirSync(`${root}/home/.claude`, { recursive: true });
  try {
    await offerSetupAgentSkill({
      interactive: true,
      env: { HOME: `${root}/home` },
      ask: async (question) => { questions.push(question); return ""; },
      log: (line) => lines.push(line),
      install: (target) => { installedTargets.push(target); return installed(target); },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  assert.equal(questions.length, 1);
  assert.match(lines.join("\n"), new RegExp(`${root}/home/\\.claude/skills/propr`));
  assert.deepEqual(installedTargets, ["claude"]);
});

test("non-interactive setup never writes agent homes without explicit targets", async () => {
  const installedTargets: AgentSkillTarget[] = [];
  await offerSetupAgentSkill({
    interactive: false,
    env: { HOME: "/tmp/propr-no-write" },
    install: (target) => { installedTargets.push(target); return installed(target); },
  });
  assert.deepEqual(installedTargets, []);

  const explicitInstalls: AgentSkillTarget[] = [];
  await offerSetupAgentSkill({
    interactive: false,
    explicitTargets: "codex,vibe",
    env: { HOME: "/tmp/propr-explicit" },
    log: () => {},
    install: (target) => { explicitInstalls.push(target); return installed(target); },
  });
  assert.deepEqual(explicitInstalls, ["codex", "vibe"]);
});

test("invalid explicit skill targets fail with the valid target list", async () => {
  const lines: string[] = [];
  await assert.rejects(
    offerSetupAgentSkill({
      interactive: false,
      explicitTargets: "nope",
      env: { HOME: "/tmp/propr-invalid-explicit" },
      log: (line) => lines.push(line),
    }),
    /unknown agent skill target\(s\): nope \(choose codex, claude, antigravity, opencode, vibe\)/
  );
  assert.equal(lines.some((line) => line.includes("skipped")), false);

  const errors: string[] = [];
  const command = createSetupCommand().exitOverride().configureOutput({ writeErr: (text) => errors.push(text) });
  await assert.rejects(
    command.parseAsync(["node", "propr", "--install-skill", "nope"]),
    (error: { code?: string; exitCode?: number }) => error.code === "commander.invalidArgument" && error.exitCode === 1
  );
  assert.match(errors.join(""), /choose codex, claude, antigravity, opencode, vibe/);
});

test("--no-skill conflicts with --install-skill", async () => {
  const errors: string[] = [];
  const command = createSetupCommand().exitOverride().configureOutput({ writeErr: (text) => errors.push(text) });
  await assert.rejects(
    command.parseAsync(["node", "propr", "--no-skill", "--install-skill", "codex"]),
    (error: { code?: string; exitCode?: number }) => error.code === "commander.conflictingOption" && error.exitCode === 1
  );
  assert.match(errors.join(""), /cannot be used with/);
});

for (const platform of ["darwin", "win32"] as const) {
  test(`setup rejects ${platform} before agent-skill, config, or engine actions`, { concurrency: false }, async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...originalPlatform, value: platform });
    const offeredTargets: Array<string | undefined> = [];
    let sequentialRuns = 0;
    let configLoads = 0;
    const exitCodes: number[] = [];

    try {
      const command = createSetupCommand({
        offerAgentSkill: async options => {
          offeredTargets.push(options?.explicitTargets);
          return [];
        },
        createConfig: async () => { configLoads += 1; return {} as never; },
        runSequential: async () => {
          sequentialRuns += 1;
          return { completed: true } as never;
        },
        exit: code => { exitCodes.push(code); },
      });

      await command.parseAsync(["node", "propr", "--no-tui", "--install-skill", "codex"]);

      assert.deepEqual(offeredTargets, []);
      assert.equal(configLoads, 0);
      assert.equal(sequentialRuns, 0);
      assert.deepEqual(exitCodes, [1]);
    } finally {
      Object.defineProperty(process, "platform", originalPlatform);
    }
  });
}

for (const proprDemoMode of [undefined, "false"] as const) {
  test(`Ink login is required for GH_AUTH_MODE=demo when PROPR_DEMO_MODE is ${proprDemoMode ?? "absent"}`, () => {
    assert.equal(shouldPrepareInkGithubLogin(proprDemoMode, false), true);
  });
}

for (const proprDemoMode of ["true", "1", "yes", "on"] as const) {
  test(`Ink login is bypassed when PROPR_DEMO_MODE is ${proprDemoMode}`, () => {
    assert.equal(shouldPrepareInkGithubLogin(proprDemoMode, false), false);
  });
}
