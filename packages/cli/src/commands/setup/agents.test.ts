/**
 * Agent enablement + image-login tests. Run with:
 * `npx tsx --test src/commands/setup/agents.test.ts` (from packages/cli).
 *
 * Every side effect is mocked, so these run without the backend, Docker, or a
 * TTY. They pin the acceptance criteria for `propr setup`'s agent step:
 *   - existing agents are never disabled or deleted,
 *   - selected agents missing from the backend are added,
 *   - authentication is attempted only for loginable agents the user confirms.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { runAgentSetup, type AgentSetupActions } from "./agents.js";
import type { AddAgentOptions, AgentConfig } from "../../api/agents.js";

/** A minimal configured agent record. */
function agent(type: AgentConfig["type"], alias: string, enabled = true): AgentConfig {
  return {
    id: `id-${alias}`,
    type,
    alias,
    enabled,
    dockerImage: "propr/agent:latest",
    configPath: `/home/u/.${type}`,
    supportedModels: ["m1"],
  };
}

/** Build a fully-inert action set; override any subset per test. */
function mockAgentActions(overrides: Partial<AgentSetupActions> = {}): AgentSetupActions {
  return {
    listAgents: async () => [],
    addAgent: async () => undefined,
    loginableAgents: async () => [],
    loginAgent: async () => ({ available: false, success: false }),
    ...overrides,
  };
}

test("no selected agents is a no-op", async () => {
  let listed = false;
  const outcome = await runAgentSetup({
    rootDir: "/stack",
    selectedAgents: [],
    actions: mockAgentActions({
      listAgents: async () => {
        listed = true;
        return [];
      },
    }),
  });
  assert.equal(listed, false, "must not even read the backend when nothing is selected");
  assert.deepEqual(outcome.added, []);
});

test("selected agents missing from the backend are added; existing ones are left intact", async () => {
  const added: AddAgentOptions[] = [];
  // claude already configured (and enabled); codex is new.
  const outcome = await runAgentSetup({
    rootDir: "/stack",
    selectedAgents: ["claude", "codex"],
    actions: mockAgentActions({
      listAgents: async () => [agent("claude", "claude", true)],
      addAgent: async (_root, options) => {
        added.push(options);
      },
    }),
  });

  assert.deepEqual(
    added.map((o) => o.type),
    ["codex"],
    "only the missing type is added"
  );
  assert.deepEqual(outcome.added, ["codex"]);
  assert.deepEqual(outcome.alreadyConfigured, ["claude"]);
  // The added agent is enabled and seeded from shared metadata.
  assert.equal(added[0].enabled, true);
  assert.equal(added[0].alias, "codex");
  assert.ok(added[0].models.length > 0, "supported models come from shared defaults");
});

test("a disabled existing agent is not re-added and is not re-enabled", async () => {
  let addCalled = false;
  const outcome = await runAgentSetup({
    rootDir: "/stack",
    selectedAgents: ["claude"],
    actions: mockAgentActions({
      // claude exists but is disabled — setup must leave it exactly as-is.
      listAgents: async () => [agent("claude", "claude", false)],
      addAgent: async () => {
        addCalled = true;
      },
    }),
  });
  assert.equal(addCalled, false, "an existing agent of that type is never re-added");
  assert.deepEqual(outcome.alreadyConfigured, ["claude"]);
  assert.deepEqual(outcome.added, []);
});

test("a failed read leaves the backend untouched", async () => {
  let addCalled = false;
  const outcome = await runAgentSetup({
    rootDir: "/stack",
    selectedAgents: ["claude"],
    actions: mockAgentActions({
      listAgents: async () => {
        throw new Error("backend unreachable");
      },
      addAgent: async () => {
        addCalled = true;
      },
    }),
  });
  assert.equal(addCalled, false, "nothing is added when the current config can't be read");
  assert.equal(outcome.errors.length, 1);
  assert.match(outcome.errors[0], /backend unreachable/);
});

test("a failed add is a recorded error, not a thrown exception", async () => {
  const outcome = await runAgentSetup({
    rootDir: "/stack",
    selectedAgents: ["codex"],
    actions: mockAgentActions({
      addAgent: async () => {
        throw new Error("alias clash");
      },
    }),
  });
  assert.deepEqual(outcome.added, []);
  assert.equal(outcome.errors.length, 1);
  assert.match(outcome.errors[0], /could not enable codex.*alias clash/);
});

test("authentication is offered only for loginable selected agents", async () => {
  const offered: string[] = [];
  await runAgentSetup({
    rootDir: "/stack",
    selectedAgents: ["claude", "vibe"],
    actions: mockAgentActions({
      // vibe has no image login; only claude is a candidate.
      loginableAgents: async () => ["claude", "codex", "antigravity", "opencode"],
    }),
    confirmLogin: async ({ candidates }) => {
      offered.push(...candidates);
      return [];
    },
  });
  assert.deepEqual(offered, ["claude"], "vibe (no login plan) is never offered");
});

test("no confirm callback means no login is attempted", async () => {
  let loginCalled = false;
  await runAgentSetup({
    rootDir: "/stack",
    selectedAgents: ["claude"],
    actions: mockAgentActions({
      loginableAgents: async () => ["claude"],
      loginAgent: async () => {
        loginCalled = true;
        return { available: true, success: true };
      },
    }),
  });
  assert.equal(loginCalled, false, "without a confirm hook, login defaults to off");
});

test("login runs only for confirmed agents and records the result", async () => {
  const loggedIn: string[] = [];
  const outcome = await runAgentSetup({
    rootDir: "/stack",
    selectedAgents: ["claude", "codex"],
    actions: mockAgentActions({
      loginableAgents: async () => ["claude", "codex"],
      loginAgent: async (_root, type) => {
        loggedIn.push(type);
        // claude succeeds; codex exits non-zero.
        return type === "claude"
          ? { available: true, success: true }
          : { available: true, success: false, detail: "exited 1" };
      },
    }),
    // User confirms both.
    confirmLogin: async ({ candidates }) => candidates,
  });

  assert.deepEqual(loggedIn, ["claude", "codex"]);
  assert.deepEqual(outcome.authenticated, ["claude"]);
  assert.deepEqual(outcome.authFailed, ["codex"]);
});

test("a confirm choice outside the candidate set is ignored", async () => {
  const loggedIn: string[] = [];
  await runAgentSetup({
    rootDir: "/stack",
    selectedAgents: ["claude"],
    actions: mockAgentActions({
      loginableAgents: async () => ["claude"],
      loginAgent: async (_root, type) => {
        loggedIn.push(type);
        return { available: true, success: true };
      },
    }),
    // Returns a non-candidate ("vibe") plus the real one.
    confirmLogin: async () => ["vibe", "claude"],
  });
  assert.deepEqual(loggedIn, ["claude"], "only confirmed candidates are logged in");
});

test("a thrown confirm prompt skips login without aborting", async () => {
  let loginCalled = false;
  const outcome = await runAgentSetup({
    rootDir: "/stack",
    selectedAgents: ["claude"],
    actions: mockAgentActions({
      loginableAgents: async () => ["claude"],
      loginAgent: async () => {
        loginCalled = true;
        return { available: true, success: true };
      },
    }),
    confirmLogin: async () => {
      throw new Error("cancelled");
    },
  });
  assert.equal(loginCalled, false);
  assert.equal(outcome.errors.length, 1);
  assert.match(outcome.errors[0], /agent login prompt failed.*cancelled/);
});
