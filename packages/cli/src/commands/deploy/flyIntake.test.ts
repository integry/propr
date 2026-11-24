/**
 * GitHub event intake selection for `propr deploy fly`. Run with:
 * `npx tsx --test src/commands/deploy/flyIntake.test.ts` (from packages/cli).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { selectFlyIntakeMode } from "./flyIntake.js";

const none = new Set<string>();
const mode = (values: Record<string, string>, existing: ReadonlySet<string> = none) => selectFlyIntakeMode(values, existing).secrets.GITHUB_EVENT_INTAKE_MODE;

test("demo mode pins the passive direct_webhook intake, whatever the .env says", () => {
  assert.equal(mode({ PROPR_DEMO_MODE: "true" }), "direct_webhook");
  assert.equal(mode({ PROPR_DEMO_MODE: "1", GITHUB_EVENT_INTAKE_MODE: "routing_websocket" }), "direct_webhook");
  assert.match(selectFlyIntakeMode({ PROPR_DEMO_MODE: "true" }, none).summary, /off \(demo mode\)/);
});

test("relay credentials route events; a relay token left by an earlier deploy counts by name", () => {
  assert.equal(mode({ PROPR_GH_RELAY_TOKEN: "rt" }), "routing_websocket");
  assert.equal(mode({ PROPR_DEMO_MODE: "false" }, new Set(["PROPR_GH_RELAY_TOKEN"])), "routing_websocket");
});

test("an own App polls without a webhook secret and takes direct webhooks with one", () => {
  const app = { GH_APP_ID: "42", PROPR_GH_PRIVATE_KEY_B64: "a2V5", GH_AUTH_MODE: "app" };
  assert.equal(mode(app), "polling");
  assert.equal(mode({ ...app, GH_WEBHOOK_SECRET: "whsec" }), "direct_webhook");
  assert.equal(mode(app, new Set(["GH_WEBHOOK_SECRET"])), "direct_webhook");
  // Relay token for Connect sign-in, own App for API auth: routing_websocket would fail the daemon's check.
  assert.equal(mode({ ...app, PROPR_GH_RELAY_TOKEN: "rt" }), "polling");
});

test("a mode the stack sets is kept only when the Machine can run it", () => {
  assert.equal(mode({ PROPR_GH_RELAY_TOKEN: "rt", GITHUB_EVENT_INTAKE_MODE: "polling" }), "polling");
  assert.throws(
    () => selectFlyIntakeMode({ GH_APP_ID: "42", PROPR_GH_PRIVATE_KEY_B64: "k", GITHUB_EVENT_INTAKE_MODE: "routing_websocket" }, none),
    /GitHub event intake routing_websocket cannot start on the Machine: routing_websocket intake requires relay auth mode.*Drop --no-relay/,
  );
  assert.throws(
    () => selectFlyIntakeMode({ GH_APP_ID: "42", PROPR_GH_PRIVATE_KEY_B64: "k", GITHUB_EVENT_INTAKE_MODE: "direct_webhook" }, none),
    /GH_WEBHOOK_SECRET must be set for direct_webhook intake/,
  );
  assert.throws(() => selectFlyIntakeMode({ PROPR_GH_RELAY_TOKEN: "rt", GITHUB_EVENT_INTAKE_MODE: "sometimes" }, none), /not a recognized value/);
});

test("no GitHub credentials anywhere is refused before deploy", () => {
  assert.throws(() => selectFlyIntakeMode({ PROPR_DEMO_MODE: "false", GH_OAUTH_CLIENT_ID: "c" }, none), /no GitHub credentials/);
  // Relay auth pinned without any token: the relay WebSocket would throw at boot.
  assert.throws(() => selectFlyIntakeMode({ GH_AUTH_MODE: "relay" }, none), /PROPR_GH_RELAY_TOKEN must be set/);
});
