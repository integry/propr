import assert from "node:assert/strict";
import { test } from "node:test";
import { AGENT_TANK_LEGACY_BACKEND_MESSAGE } from "@propr/shared";
import type { ApiClient } from "../api/index.js";
import { getAgentTank, setAgentTank } from "../api/agentTank.js";
import { parseTankMode } from "./tankCommands.js";

test("parseTankMode accepts the three modes plus the off/on aliases", () => {
  assert.equal(parseTankMode("bundled"), "bundled");
  assert.equal(parseTankMode("external"), "external");
  assert.equal(parseTankMode("disabled"), "disabled");
  assert.equal(parseTankMode(" OFF "), "disabled");
  // `on` has always meant "use my host install", so it maps to external and
  // never silently repoints an existing user at a container.
  assert.equal(parseTankMode("on"), "external");
  assert.equal(parseTankMode("bundle"), undefined);
  assert.equal(parseTankMode(""), undefined);
});

function fakeClient(
  recorded: Array<{ endpoint: string; body?: unknown }>,
  current: Record<string, unknown> = { mode: "external", enabled: true, url: "http://saved:3456" },
): ApiClient {
  return {
    get: async (endpoint: string) => {
      recorded.push({ endpoint });
      return { data: current };
    },
    post: async (endpoint: string, options?: { body?: unknown }) => {
      recorded.push({ endpoint, body: options?.body });
      return { data: { success: true } };
    },
  } as unknown as ApiClient;
}

test("setAgentTank sends the mode and preserves the saved URL when none is given", async () => {
  const recorded: Array<{ endpoint: string; body?: unknown }> = [];

  const result = await setAgentTank("bundled", undefined, fakeClient(recorded));

  assert.deepEqual(result, { mode: "bundled", enabled: true, url: "http://saved:3456" });
  assert.deepEqual(recorded.at(-1), {
    endpoint: "/api/config/agent-tank",
    body: { mode: "bundled", enabled: true, url: "http://saved:3456" },
  });
});

test("setAgentTank sends an explicit URL without reading the current settings", async () => {
  const recorded: Array<{ endpoint: string; body?: unknown }> = [];

  const result = await setAgentTank("external", "http://127.0.0.1:9999", fakeClient(recorded));

  assert.equal(result.url, "http://127.0.0.1:9999");
  assert.deepEqual(recorded, [{
    endpoint: "/api/config/agent-tank",
    body: { mode: "external", enabled: true, url: "http://127.0.0.1:9999" },
  }]);
});

test("setAgentTank derives enabled false only for the disabled mode", async () => {
  const recorded: Array<{ endpoint: string; body?: unknown }> = [];

  assert.equal((await setAgentTank("disabled", "http://x:1", fakeClient(recorded))).enabled, false);
  assert.equal((await setAgentTank("external", "http://x:1", fakeClient(recorded))).enabled, true);
});

test("external and disabled writes carry the enabled flag a pre-mode backend reads", async () => {
  // An older backend handler reads `{ enabled, url }` and stores
  // `enabled: !!enabled`. Sending `mode` alone would make it persist "off"
  // while answering success, so the derived flag must travel with every write.
  const recorded: Array<{ endpoint: string; body?: unknown }> = [];
  const legacy = { enabled: true, url: "http://legacy:3456" };

  await setAgentTank("external", "http://legacy:3456", fakeClient(recorded, legacy));
  assert.deepEqual(recorded.at(-1)?.body, {
    mode: "external",
    enabled: true,
    url: "http://legacy:3456",
  });

  await setAgentTank("disabled", "http://legacy:3456", fakeClient(recorded, legacy));
  assert.deepEqual(recorded.at(-1)?.body, {
    mode: "disabled",
    enabled: false,
    url: "http://legacy:3456",
  });
});

test("bundled is refused against a backend that does not understand modes", async () => {
  const recorded: Array<{ endpoint: string; body?: unknown }> = [];
  // Pre-mode backend: `{ enabled, url }` with no `mode` at all.
  const client = fakeClient(recorded, { enabled: true, url: "http://legacy:3456" });

  await assert.rejects(
    setAgentTank("bundled", undefined, client),
    (error: Error) => error.message === AGENT_TANK_LEGACY_BACKEND_MESSAGE,
  );
  // Nothing was written: an unsupported mode must not be reported as applied.
  assert.deepEqual(recorded.filter(entry => entry.body !== undefined), []);
});

test("getAgentTank derives the mode a pre-mode backend does not report", async () => {
  const recorded: Array<{ endpoint: string; body?: unknown }> = [];

  const legacyOn = await getAgentTank(fakeClient(recorded, { enabled: true, url: "http://legacy:3456" }));
  assert.equal(legacyOn.mode, "external");
  assert.equal(legacyOn.supportsModes, false);

  const legacyOff = await getAgentTank(fakeClient(recorded, { enabled: false, url: "" }));
  assert.equal(legacyOff.mode, "disabled");
});

test("getAgentTank returns the backend settings unchanged", async () => {
  const recorded: Array<{ endpoint: string; body?: unknown }> = [];

  const settings = await getAgentTank(fakeClient(recorded, { mode: "bundled", enabled: true, url: "" }));

  assert.equal(settings.mode, "bundled");
  assert.equal(settings.supportsModes, true);
  assert.deepEqual(recorded, [{ endpoint: "/api/config/agent-tank" }]);
});
