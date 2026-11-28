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

/** `null` means not logged in (no `propr login` token). */
function prepare(flags: Omit<DeployFlyOptions, "app">, envFile: Record<string, string>, githubToken: string | null = "gh") {
  return prepareFlyDeploy({ app: "my-propr", legacyDocker: true, ...flags }, IMAGES, { PROPR_ADMIN_USERS: "owner", ...envFile }, githubToken ?? undefined);
}

test("a relay-only deploy signs browsers in with GitHub device flow, no tunnel or OAuth client", () => {
  // Logged in: the deploy enrolls a relay token, and that token is the sign-in.
  for (const flags of [{}, { dryRun: true }]) {
    const prepared = prepare(flags, {});
    assert.equal(prepared.relayPlan.kind, "enroll");
    assert.equal(prepared.browserAuth, "device");
    assert.equal(buildAppEnv(prepared.plan).PROPR_WEB_AUTH_MODE, undefined, "the API infers device mode itself");
    assert.match(describeFlyBrowserAuth(prepared.plan, prepared.browserAuth), /device sign-in at https:\/\/my-propr\.fly\.dev/);
    assert.ok(prepared.notes.some((note) => /device flow/.test(note) && /Device Flow must be enabled/.test(note)));
  }
  // A hosted relay token already in the stack works too; its URL is pinned for the API.
  const existing = prepare({}, { PROPR_GH_RELAY_TOKEN: "existing" }, null);
  assert.equal(existing.browserAuth, "device");
  assert.deepEqual(existing.relayPlan, { kind: "fill-url", baseUrl: "https://webhook.propr.dev/v1", keepOwnApp: false });
  assert.equal(prepare({}, { PROPR_GH_RELAY_TOKEN: "existing", PROPR_GH_RELAY_URL: "https://webhook.propr.dev/v1/" }).browserAuth, "device");
});

test("an operator relay needs its own App's client ID for device sign-in", () => {
  const custom = { PROPR_GH_RELAY_TOKEN: "existing", PROPR_GH_RELAY_URL: "https://relay.example.com/v1" };
  assert.throws(() => prepare({}, custom), (error: Error) => {
    assert.match(error.message, /nobody can sign in/);
    assert.match(error.message, /PROPR_GH_DEVICE_CLIENT_ID/);
    return true;
  });
  assert.equal(prepare({}, { ...custom, PROPR_GH_DEVICE_CLIENT_ID: "Iv23custom" }).browserAuth, "device");
});

test("a deploy with no relay token, tunnel or OAuth client is refused before provisioning", () => {
  // Not logged in, so no relay token can be enrolled.
  for (const flags of [{}, { dryRun: true }]) {
    assert.throws(
      () => prepare(flags, {}, null),
      (error: Error) => {
        assert.match(error.message, /nobody can sign in/);
        assert.match(error.message, /propr login/);
        assert.match(error.message, /--tunnel-token and --tunnel-url/);
        assert.match(error.message, /GH_OAUTH_CLIENT_ID and GH_OAUTH_CLIENT_SECRET/);
        assert.match(error.message, /https:\/\/my-propr\.fly\.dev\/api\/auth\/github\/callback/);
        return true;
      },
    );
  }
  // --no-relay keeps the deploy from enrolling one.
  assert.throws(() => prepare({ relay: false }, {}), /nobody can sign in/);
  // Only one half of the OAuth client, or placeholders, is not a client.
  assert.throws(() => prepare({}, { GH_OAUTH_CLIENT_ID: "Iv1.client" }, null), /nobody can sign in/);
  assert.throws(() => prepare({}, { GH_OAUTH_CLIENT_ID: "your_client_id", GH_OAUTH_CLIENT_SECRET: "changeme" }, null), /nobody can sign in/);
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
  assert.equal(prepare({}, OAUTH_ENV, null).browserAuth, "github");
});

test("demo mode needs no sign-in", () => {
  const demo = prepare({}, { PROPR_DEMO_MODE: "true" });
  assert.equal(demo.browserAuth, "demo");
  assert.equal(demo.secrets.PROPR_DEMO_MODE, "true");
  assert.throws(() => prepare({}, { PROPR_DEMO_MODE: "false" }, null), /nobody can sign in/);
});

test("GitHub and Connect sign-in switch demo mode off explicitly, so a retained Fly secret cannot keep it on", () => {
  assert.equal(prepare({}, OAUTH_ENV).secrets.PROPR_DEMO_MODE, "false");
  assert.equal(prepare(TUNNEL_FLAGS, {}).secrets.PROPR_DEMO_MODE, "false");
  // A stack .env that already says so is uploaded as is.
  assert.equal(prepare({}, { ...OAUTH_ENV, PROPR_DEMO_MODE: "0" }).secrets.PROPR_DEMO_MODE, "0");
});
