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
  const app = { GH_APP_ID: "42", PROPR_GH_PRIVATE_KEY_B64: "a2V5", GH_INSTALLATION_ID: "777", GH_AUTH_MODE: "app" };
  assert.equal(mode(app), "polling");
  assert.equal(mode({ ...app, GH_WEBHOOK_SECRET: "whsec" }), "direct_webhook");
  assert.equal(mode(app, new Set(["GH_WEBHOOK_SECRET"])), "direct_webhook");
  // Relay token for Connect sign-in, own App for API auth: routing_websocket would fail the daemon's check.
  assert.equal(mode({ ...app, PROPR_GH_RELAY_TOKEN: "rt" }), "polling");
});

test("a mode the stack sets is kept only when the Machine can run it", () => {
  assert.equal(mode({ PROPR_GH_RELAY_TOKEN: "rt", GITHUB_EVENT_INTAKE_MODE: "polling" }), "polling");
  assert.throws(
    () => selectFlyIntakeMode({ GH_APP_ID: "42", PROPR_GH_PRIVATE_KEY_B64: "k", GH_INSTALLATION_ID: "777", GITHUB_EVENT_INTAKE_MODE: "routing_websocket" }, none),
    /GitHub event intake routing_websocket cannot start on the Machine: routing_websocket intake requires relay auth mode.*Drop --no-relay/,
  );
  assert.throws(
    () => selectFlyIntakeMode({ GH_APP_ID: "42", PROPR_GH_PRIVATE_KEY_B64: "k", GH_INSTALLATION_ID: "777", GITHUB_EVENT_INTAKE_MODE: "direct_webhook" }, none),
    /GH_WEBHOOK_SECRET must be set for direct_webhook intake/,
  );
  assert.throws(() => selectFlyIntakeMode({ PROPR_GH_RELAY_TOKEN: "rt", GITHUB_EVENT_INTAKE_MODE: "sometimes" }, none), /not a recognized value/);
});

test("no GitHub credentials anywhere is refused before deploy", () => {
  assert.throws(() => selectFlyIntakeMode({ PROPR_DEMO_MODE: "false", GH_OAUTH_CLIENT_ID: "c" }, none), /no GitHub credentials/);
  // Relay auth pinned without any token: the relay WebSocket would throw at boot.
  assert.throws(() => selectFlyIntakeMode({ GH_AUTH_MODE: "relay" }, none), /GitHub auth mode relay on the Machine needs PROPR_GH_RELAY_TOKEN/);
  // An App without its installation id is not inferred: core auth would resolve no mode.
  assert.throws(() => selectFlyIntakeMode({ GH_APP_ID: "42", PROPR_GH_PRIVATE_KEY_B64: "k" }, none), /no GitHub credentials/);
});

test("an explicit GH_AUTH_MODE needs its own credentials whatever the intake mode", () => {
  // The --no-relay case: OAuth sign-in only, GH_AUTH_MODE=app, no App. Polling
  // would pass the intake check, and core auth would exit at boot.
  const oauth = { GH_OAUTH_CLIENT_ID: "c", GH_OAUTH_CLIENT_SECRET: "s", PROPR_DEMO_MODE: "false" };
  for (const intake of [{}, { GITHUB_EVENT_INTAKE_MODE: "polling" }]) {
    assert.throws(
      () => selectFlyIntakeMode({ ...oauth, ...intake, GH_AUTH_MODE: "app" }, none),
      /GitHub auth mode app on the Machine needs GH_APP_ID, the App private key \(HOST_GH_PRIVATE_KEY or --github-app-key\), GH_INSTALLATION_ID/,
    );
    assert.throws(
      () => selectFlyIntakeMode({ ...oauth, ...intake, GH_AUTH_MODE: "relay" }, none),
      /GitHub auth mode relay on the Machine needs PROPR_GH_RELAY_TOKEN/,
    );
  }
  // Only the missing piece is named.
  assert.throws(
    () => selectFlyIntakeMode({ GH_AUTH_MODE: "app", GH_APP_ID: "42", PROPR_GH_PRIVATE_KEY_B64: "k", GITHUB_EVENT_INTAKE_MODE: "polling" }, none),
    (error: Error) => /needs GH_INSTALLATION_ID,/.test(error.message) && !/needs GH_APP_ID/.test(error.message),
  );
  // Secrets an earlier deploy left count by name; a value blanked this run does not.
  const appSecrets = new Set(["GH_APP_ID", "PROPR_GH_PRIVATE_KEY_B64", "GH_INSTALLATION_ID"]);
  assert.equal(mode({ GH_AUTH_MODE: "app", GITHUB_EVENT_INTAKE_MODE: "polling" }, appSecrets), "polling");
  assert.equal(mode({ GH_AUTH_MODE: "relay", GITHUB_EVENT_INTAKE_MODE: "polling" }, new Set(["PROPR_GH_RELAY_TOKEN"])), "polling");
  assert.throws(
    () => selectFlyIntakeMode({ GH_AUTH_MODE: "app", GH_INSTALLATION_ID: "", GITHUB_EVENT_INTAKE_MODE: "polling" }, appSecrets),
    /needs GH_INSTALLATION_ID/,
  );
});

test("a GH_AUTH_MODE left by an earlier deploy is unreadable: with relay and App credentials the intake must suit both", () => {
  const earlier = new Set(["GH_AUTH_MODE", "GH_APP_ID", "PROPR_GH_PRIVATE_KEY_B64", "GH_INSTALLATION_ID", "PROPR_GH_RELAY_TOKEN"]);
  // The intake that earlier deploy pinned next to its mode is kept (nothing uploaded).
  const kept = selectFlyIntakeMode({ PROPR_DEMO_MODE: "false" }, new Set([...earlier, "GITHUB_EVENT_INTAKE_MODE"]));
  assert.deepEqual(kept.secrets, {});
  assert.match(kept.summary, /kept from the earlier deploy/);
  // No intake to keep: polling runs under relay and app auth alike.
  assert.equal(mode({ PROPR_DEMO_MODE: "false" }, earlier), "polling");
  assert.equal(mode({ PROPR_DEMO_MODE: "false" }, new Set([...earlier, "GH_WEBHOOK_SECRET"])), "polling");
  // A stack intake that only one of the two modes can run is refused.
  assert.throws(
    () => selectFlyIntakeMode({ GITHUB_EVENT_INTAKE_MODE: "routing_websocket" }, earlier),
    /routing_websocket intake requires relay auth mode.*set GH_AUTH_MODE \(relay or app\)/,
  );
  // This run's GH_AUTH_MODE settles it.
  assert.equal(mode({ GH_AUTH_MODE: "relay" }, earlier), "routing_websocket");
  // Only one kind of credential: the earlier mode can only be that one.
  assert.equal(mode({}, new Set(["GH_AUTH_MODE", "PROPR_GH_RELAY_TOKEN"])), "routing_websocket");
});
