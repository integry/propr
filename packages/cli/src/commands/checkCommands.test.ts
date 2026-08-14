import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { AgentTankUsage } from "./agentValidation.js";
import { printAgentTankUsage } from "./checkCommands.js";

test("Agent Tank usage rendering ignores null metric entries", (t) => {
  const fixture = JSON.parse(
    readFileSync(new URL("./fixtures/agent-tank-null-label.json", import.meta.url), "utf8")
  ) as NonNullable<AgentTankUsage["usage"]>;
  const lines: string[] = [];
  t.mock.method(console, "log", (...args: unknown[]) => {
    lines.push(args.join(" "));
  });

  assert.doesNotThrow(() => {
    printAgentTankUsage({ installed: true, version: "0.9.10", usage: fixture }, false);
  });

  const output = lines.join("\n");
  assert.match(output, /Weekly limit: 12% \(resets 3d 4h\)/);
  assert.doesNotMatch(output, /usage: \?%/);
});
