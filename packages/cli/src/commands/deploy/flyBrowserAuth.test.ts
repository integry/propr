/**
 * Browser sign-in for `propr deploy fly`: the deploy refuses a control plane
 * nobody could sign in to before it contacts Fly. Run with:
 * `npx tsx --test src/commands/deploy/flyBrowserAuth.test.ts` (from packages/cli).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { prepareFlyDeploy, type DeployFlyOptions } from "../deployFly.js";
import { describeFlyBrowserAuth } from "./flyBrowserAuth.js";
import { buildAppEnv } from "./flyMachineConfig.js";

const IMAGES = { app: "propr/app:0.9.3", redis: "redis:7-alpine", cloudflared: "cloudflare/cloudflared:2024.12.2" };
const TUNNEL_FLAGS = { tunnelToken: "cf-token", tunnelUrl: "https://t-abc123.propr.dev" };
const OAUTH_ENV = { GH_OAUTH_CLIENT_ID: "Iv1.client", GH_OAUTH_CLIENT_SECRET: "oauth-secret" };

function prepare(flags: Omit<DeployFlyOptions, "app">, envFile: Record<string, string>, githubToken: string | undefined = "gh") {
  return prepareFlyDeploy({ app: "my-propr", legacyDocker: true, ...flags }, IMAGES, envFile, githubToken);
}

test("default deploy without Connect or a GitHub OAuth client is refused before provisioning", () => {
  // Logged in, so a relay token would be enrolled: that serves GitHub API calls, not browser sign-in.
  for (const flags of [{}, { dryRun: true }, { idleShutdown: "15m" }]) {
    assert.throws(
      () => prepare(flags, {}),
      (error: Error) => {
        assert.match(error.message, /nobody can sign in/);
        assert.match(error.message, /--tunnel-token and --tunnel-url/);
        assert.match(error.message, /GH_OAUTH_CLIENT_ID and GH_OAUTH_CLIENT_SECRET/);
        assert.match(error.message, /https:\/\/my-propr\.fly\.dev\/api\/auth\/github\/callback/);
        return true;
      },
    );
  }
  // A relay token already in the stack does not help either: Connect's automatic path needs a loopback callback.
  assert.throws(() => prepare({}, { PROPR_GH_RELAY_TOKEN: "existing", PROPR_GH_RELAY_URL: "https://webhook.propr.dev" }), /nobody can sign in/);
  // Only one half of the OAuth client, or placeholders, is not a client.
  assert.throws(() => prepare({}, { GH_OAUTH_CLIENT_ID: "Iv1.client" }), /nobody can sign in/);
  assert.throws(() => prepare({}, { GH_OAUTH_CLIENT_ID: "your_client_id", GH_OAUTH_CLIENT_SECRET: "changeme" }), /nobody can sign in/);
});

test("Connect tunnel flags sign browsers in through the hosted UI", () => {
  const prepared = prepare(TUNNEL_FLAGS, {});
  assert.equal(prepared.browserAuth, "connect");
  assert.equal(prepared.relayPlan.kind, "enroll");
  const env = buildAppEnv(prepared.plan);
  assert.equal(env.PROPR_WEB_AUTH_MODE, "connect");
  assert.equal(env.PROPR_UI_TUNNEL_ENABLED, "true");
  assert.equal(describeFlyBrowserAuth(prepared.plan, prepared.browserAuth), "ProPR Connect at https://app.propr.dev");
});

test("a GitHub OAuth client in the stack .env signs browsers in on the public URL", () => {
  const prepared = prepare({}, OAUTH_ENV);
  assert.equal(prepared.browserAuth, "github");
  assert.equal(prepared.secrets.GH_OAUTH_CLIENT_ID, "Iv1.client");
  assert.equal(prepared.secrets.GH_OAUTH_CLIENT_SECRET, "oauth-secret");
  const callback = buildAppEnv(prepared.plan).GH_OAUTH_CALLBACK_URL;
  assert.equal(callback, "https://my-propr.fly.dev/api/auth/github/callback");
  assert.ok(prepared.notes.some((note) => note.includes(callback)), "the callback to register is printed");
  // A stack callback URL never redirects GitHub elsewhere: the deploy owns it.
  const local = prepare({}, { ...OAUTH_ENV, GH_OAUTH_CALLBACK_URL: "http://localhost:4000/api/auth/github/callback" });
  assert.equal(local.secrets.GH_OAUTH_CALLBACK_URL, undefined);
  // Works without a GitHub login too: no relay is needed for OAuth sign-in.
  assert.equal(prepare({}, OAUTH_ENV, undefined).browserAuth, "github");
});

test("demo mode needs no sign-in", () => {
  const demo = prepare({}, { PROPR_DEMO_MODE: "true" });
  assert.equal(demo.browserAuth, "demo");
  assert.equal(demo.secrets.PROPR_DEMO_MODE, "true");
  assert.throws(() => prepare({}, { PROPR_DEMO_MODE: "false" }), /nobody can sign in/);
});

test("GitHub and Connect sign-in switch demo mode off explicitly, so a retained Fly secret cannot keep it on", () => {
  assert.equal(prepare({}, OAUTH_ENV).secrets.PROPR_DEMO_MODE, "false");
  assert.equal(prepare(TUNNEL_FLAGS, {}).secrets.PROPR_DEMO_MODE, "false");
  // A stack .env that already says so is uploaded as is.
  assert.equal(prepare({}, { ...OAUTH_ENV, PROPR_DEMO_MODE: "0" }).secrets.PROPR_DEMO_MODE, "0");
});
