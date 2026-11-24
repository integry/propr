/**
 * Relay enrollment for `propr deploy fly`, including Connect with an own App.
 * Run with: `npx tsx --test src/commands/deploy/flyRelay.test.ts` (from packages/cli).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_PROPR_GH_RELAY_URL, resolveGithubAuthMode } from "@propr/shared";
import { collectFlySecrets, resolveFlyDeployPlan, type DeployFlyOptions } from "../deployFly.js";
import { buildAppEnv, FLY_GH_PRIVATE_KEY_PATH, FLY_GH_PRIVATE_KEY_SECRET } from "./flyMachineConfig.js";
import { planFlyRelay, resolveFlyRelaySecrets, type FlyRelayDeps } from "./flyRelay.js";

const IMAGES = { app: "propr/app:0.9.3", redis: "redis:7-alpine", cloudflared: "cloudflare/cloudflared:2024.12.2" };
const OWN_APP_ENV = { GH_APP_ID: "42", GH_INSTALLATION_ID: "777", HOST_GH_PRIVATE_KEY: "/keys/app.pem" };
const TUNNEL_FLAGS = { tunnelToken: "cf-token", tunnelUrl: "https://t-abc123.propr.dev", spritesToken: "sp" };

function stubDeps(installations = ["9001"]) {
  const calls: { discovered: number; enrolled: { baseUrl: string; installationId: string; label: string }[] } = { discovered: 0, enrolled: [] };
  const deps: FlyRelayDeps = {
    discoverInstallationId: async () => {
      calls.discovered += 1;
      if (installations.length !== 1) throw new Error("ambiguous");
      return installations[0];
    },
    enrollRelayToken: async (client, body) => {
      calls.enrolled.push({ baseUrl: client.baseUrl, ...body });
      return { token: "relay-token" };
    },
  };
  return { deps, calls };
}

/** Collected secrets plus the plan, exactly as runDeployFly builds them. */
function collect(options: Omit<DeployFlyOptions, "app">, envFile: Record<string, string>) {
  const full = { app: "my-propr", ...options };
  const plan = resolveFlyDeployPlan(full, IMAGES);
  const { secrets } = collectFlySecrets(plan, full, envFile, () => "-----BEGIN KEY-----\n");
  return { plan, secrets, options: full };
}

test("own App + Connect tunnel and no relay token: enrolls for Connect and keeps the own App for API auth", async () => {
  const { plan, secrets, options } = collect(TUNNEL_FLAGS, OWN_APP_ENV);
  assert.ok(plan.tunnel);
  assert.ok(secrets[FLY_GH_PRIVATE_KEY_SECRET]);
  const { deps, calls } = stubDeps();
  const relay = await resolveFlyRelaySecrets(options, secrets, { connect: true, githubToken: "gh", label: "fly:my-propr@h" }, deps);
  assert.ok(relay);
  assert.equal(relay.enrolledInstallationId, "9001");
  // The own App's installation id is not the shared-App installation the relay token is bound to.
  assert.equal(calls.discovered, 1);
  assert.deepEqual(calls.enrolled, [{ baseUrl: DEFAULT_PROPR_GH_RELAY_URL, installationId: "9001", label: "fly:my-propr@h" }]);
  assert.deepEqual(relay.secrets, { PROPR_GH_RELAY_URL: DEFAULT_PROPR_GH_RELAY_URL, PROPR_GH_RELAY_TOKEN: "relay-token", GH_AUTH_MODE: "app" });

  // The Machine env now satisfies Connect browser auth and still mints tokens with the own App.
  const machineEnv: Record<string, string> = { ...secrets, ...relay.secrets, ...buildAppEnv(plan) };
  assert.equal(machineEnv.PROPR_WEB_AUTH_MODE, "connect");
  for (const key of ["PROPR_GH_RELAY_URL", "PROPR_GH_RELAY_TOKEN", "GH_OAUTH_CALLBACK_URL", "FRONTEND_URL"]) {
    assert.ok(machineEnv[key], `Connect needs ${key}`);
  }
  assert.equal(machineEnv.GH_INSTALLATION_ID, "777");
  assert.equal(resolveGithubAuthMode({
    ghAuthMode: machineEnv.GH_AUTH_MODE,
    relayUrl: machineEnv.PROPR_GH_RELAY_URL,
    relayToken: machineEnv.PROPR_GH_RELAY_TOKEN,
    appId: machineEnv.GH_APP_ID,
    privateKeyPath: FLY_GH_PRIVATE_KEY_PATH,
    installationId: machineEnv.GH_INSTALLATION_ID,
  }).mode, "app");
});

test("own App + Connect: --installation picks the relay installation; an explicit GH_AUTH_MODE is kept", async () => {
  const { secrets, options } = collect({ ...TUNNEL_FLAGS, installation: "555" }, { ...OWN_APP_ENV, GH_AUTH_MODE: "app" });
  const { deps, calls } = stubDeps([]);
  const relay = await resolveFlyRelaySecrets(options, secrets, { connect: true, githubToken: "gh", label: "l" }, deps);
  assert.equal(calls.discovered, 0);
  assert.equal(calls.enrolled[0].installationId, "555");
  assert.equal(relay?.secrets.GH_AUTH_MODE, "app");
  assert.equal(relay?.secrets.GH_INSTALLATION_ID, undefined);
});

test("own App + Connect without a GitHub login fails before provisioning with the fix", () => {
  const { secrets, options } = collect(TUNNEL_FLAGS, OWN_APP_ENV);
  assert.throws(() => planFlyRelay(options, secrets, { connect: true }), /propr login.*PROPR_GH_RELAY_TOKEN/s);
});

test("Connect with --no-relay and no relay token fails before provisioning", () => {
  const { secrets, options } = collect({ ...TUNNEL_FLAGS, relay: false }, OWN_APP_ENV);
  assert.throws(() => planFlyRelay(options, secrets, { connect: true, githubToken: "gh" }), /--no-relay.*PROPR_GH_RELAY_TOKEN/s);
  // Without an own App the same combination fails the same way.
  const bare = collect({ ...TUNNEL_FLAGS, relay: false }, {});
  assert.throws(() => planFlyRelay(bare.options, bare.secrets, { connect: true, githubToken: "gh" }), /--no-relay/);
});

test("Connect with an existing relay token does not re-enroll; a missing relay URL is pinned to the default", async () => {
  const { secrets, options } = collect(TUNNEL_FLAGS, { ...OWN_APP_ENV, PROPR_GH_RELAY_TOKEN: "existing" });
  const { deps, calls } = stubDeps();
  const relay = await resolveFlyRelaySecrets(options, secrets, { connect: true, label: "l" }, deps);
  assert.equal(calls.enrolled.length, 0);
  assert.deepEqual(relay, { secrets: { PROPR_GH_RELAY_URL: DEFAULT_PROPR_GH_RELAY_URL } });

  const withUrl = collect(TUNNEL_FLAGS, { PROPR_GH_RELAY_TOKEN: "existing", PROPR_GH_RELAY_URL: "https://relay.example/v1" });
  assert.equal(await resolveFlyRelaySecrets(withUrl.options, withUrl.secrets, { connect: true, label: "l" }, deps), undefined);
});

test("without Connect an own App still suppresses automatic enrollment", async () => {
  const { plan, secrets, options } = collect({ spritesToken: "sp" }, OWN_APP_ENV);
  assert.equal(plan.tunnel, undefined);
  const { deps, calls } = stubDeps();
  assert.equal(await resolveFlyRelaySecrets(options, secrets, { connect: false, githubToken: "gh", label: "l" }, deps), undefined);
  assert.equal(calls.enrolled.length, 0);
});

test("shared-App stack: automatic enrollment switches to relay auth; no login skips it", async () => {
  const { secrets, options } = collect({ spritesToken: "sp" }, { GH_INSTALLATION_ID: "321" });
  const { deps, calls } = stubDeps();
  const relay = await resolveFlyRelaySecrets(options, secrets, { connect: false, githubToken: "gh", label: "l" }, deps);
  assert.equal(calls.discovered, 0);
  assert.deepEqual(relay?.secrets, {
    PROPR_GH_RELAY_URL: DEFAULT_PROPR_GH_RELAY_URL,
    PROPR_GH_RELAY_TOKEN: "relay-token",
    GH_AUTH_MODE: "relay",
    GH_INSTALLATION_ID: "321",
  });
  assert.equal(await resolveFlyRelaySecrets(options, secrets, { connect: false, label: "l" }, deps), undefined);
  assert.throws(() => planFlyRelay({ relay: true }, secrets, { connect: false }), /--relay needs a GitHub login/);
});
