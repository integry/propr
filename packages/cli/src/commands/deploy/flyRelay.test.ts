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

/**
 * GitHub API auth mode of the Machine env runDeployFly sets, as both consumers
 * infer it: the API server reads PROPR_GH_RELAY_URL as is, core defaults it.
 */
function machineAuthModes(secrets: Record<string, string>, relaySecrets: Record<string, string> = {}) {
  const env: Record<string, string> = { ...secrets, ...relaySecrets };
  return [env.PROPR_GH_RELAY_URL, env.PROPR_GH_RELAY_URL?.trim() || DEFAULT_PROPR_GH_RELAY_URL].map((relayUrl) => resolveGithubAuthMode({
    ghAuthMode: env.GH_AUTH_MODE,
    relayUrl,
    relayToken: env.PROPR_GH_RELAY_TOKEN,
    appId: env.GH_APP_ID,
    privateKeyPath: env[FLY_GH_PRIVATE_KEY_SECRET] ? FLY_GH_PRIVATE_KEY_PATH : undefined,
    installationId: env.GH_INSTALLATION_ID,
  }).mode);
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
  assert.deepEqual(machineAuthModes(secrets, relay.secrets), ["app", "app"]);
});

test("own App + Connect: --installation picks the relay installation; an explicit GH_AUTH_MODE is kept", async () => {
  const { secrets, options } = collect({ ...TUNNEL_FLAGS, installation: "555" }, { ...OWN_APP_ENV, GH_AUTH_MODE: "app" });
  const { deps, calls } = stubDeps([]);
  const relay = await resolveFlyRelaySecrets(options, secrets, { connect: true, githubToken: "gh", label: "l" }, deps);
  assert.equal(calls.discovered, 0);
  assert.equal(calls.enrolled[0].installationId, "555");
  assert.equal(relay?.secrets.GH_INSTALLATION_ID, undefined);
  assert.deepEqual(machineAuthModes(secrets, relay?.secrets), ["app", "app"]);
});

test("own App + Connect with GH_AUTH_MODE=relay: enrolls for relay auth and binds its installation", async () => {
  // `propr relay enroll` pins relay mode and writes the shared-App installation next to leftover App credentials.
  const { secrets, options } = collect(TUNNEL_FLAGS, { ...OWN_APP_ENV, GH_AUTH_MODE: "relay", GH_INSTALLATION_ID: "321" });
  const { deps, calls } = stubDeps([]);
  const relay = await resolveFlyRelaySecrets(options, secrets, { connect: true, githubToken: "gh", label: "l" }, deps);
  assert.equal(calls.discovered, 0);
  assert.equal(calls.enrolled[0].installationId, "321");
  assert.equal(relay?.secrets.GH_INSTALLATION_ID, "321");
  assert.deepEqual(machineAuthModes(secrets, relay?.secrets), ["relay", "relay"]);
});

test("own App + --relay: the own App's installation is not sent to the relay", async () => {
  for (const connect of [false, true]) {
    const flags = connect ? { ...TUNNEL_FLAGS, relay: true } : { spritesToken: "sp", relay: true };
    const { secrets, options } = collect(flags, OWN_APP_ENV);
    const { deps, calls } = stubDeps();
    const relay = await resolveFlyRelaySecrets(options, secrets, { connect, githubToken: "gh", label: "l" }, deps);
    assert.equal(calls.discovered, 1, `connect=${connect}`);
    assert.deepEqual(calls.enrolled.map((call) => call.installationId), ["9001"], `connect=${connect}`);
    // --relay switches API auth to the relay, bound to the discovered installation.
    assert.equal(relay?.secrets.GH_INSTALLATION_ID, "9001");
    assert.deepEqual(machineAuthModes(secrets, relay?.secrets), ["relay", "relay"]);
  }
  // Without a shared-App installation to discover, --installation picks it; 777 is never used.
  const { secrets, options } = collect({ spritesToken: "sp", relay: true, installation: "555" }, OWN_APP_ENV);
  const { deps, calls } = stubDeps([]);
  await resolveFlyRelaySecrets(options, secrets, { connect: false, githubToken: "gh", label: "l" }, deps);
  assert.equal(calls.discovered, 0);
  assert.deepEqual(calls.enrolled.map((call) => call.installationId), ["555"]);
  const ambiguous = stubDeps(["9001", "9002"]);
  await assert.rejects(resolveFlyRelaySecrets({ ...options, installation: undefined }, secrets, { connect: false, githubToken: "gh", label: "l" }, ambiguous.deps), /ambiguous/);
  assert.equal(ambiguous.calls.enrolled.length, 0);
});

test("GitHub App id without its key: automatic enrollment discovers the shared-App installation", async () => {
  const { secrets, options } = collect({ spritesToken: "sp" }, { GH_APP_ID: "42", GH_INSTALLATION_ID: "777" });
  assert.equal(secrets[FLY_GH_PRIVATE_KEY_SECRET], undefined);
  const { deps, calls } = stubDeps();
  const relay = await resolveFlyRelaySecrets(options, secrets, { connect: false, githubToken: "gh", label: "l" }, deps);
  assert.equal(calls.discovered, 1);
  assert.deepEqual(calls.enrolled.map((call) => call.installationId), ["9001"]);
  assert.equal(relay?.secrets.GH_INSTALLATION_ID, "9001");
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
  const { secrets, options } = collect(TUNNEL_FLAGS, { PROPR_GH_RELAY_TOKEN: "existing", GH_INSTALLATION_ID: "321" });
  const { deps, calls } = stubDeps();
  const relay = await resolveFlyRelaySecrets(options, secrets, { connect: true, label: "l" }, deps);
  assert.equal(calls.enrolled.length, 0);
  assert.deepEqual(relay, { secrets: { PROPR_GH_RELAY_URL: DEFAULT_PROPR_GH_RELAY_URL } });
  assert.deepEqual(machineAuthModes(secrets, relay?.secrets), ["relay", "relay"]);

  const withUrl = collect(TUNNEL_FLAGS, { PROPR_GH_RELAY_TOKEN: "existing", PROPR_GH_RELAY_URL: "https://relay.example/v1" });
  assert.equal(await resolveFlyRelaySecrets(withUrl.options, withUrl.secrets, { connect: true, label: "l" }, deps), undefined);
});

test("own App + Connect with an existing relay token keeps the own App for API auth", async () => {
  const { deps, calls } = stubDeps();
  const context = { connect: true, label: "l" };
  const noUrl = collect(TUNNEL_FLAGS, { ...OWN_APP_ENV, PROPR_GH_RELAY_TOKEN: "existing" });
  const filled = await resolveFlyRelaySecrets(noUrl.options, noUrl.secrets, context, deps);
  assert.deepEqual(filled, { secrets: { PROPR_GH_RELAY_URL: DEFAULT_PROPR_GH_RELAY_URL, GH_AUTH_MODE: "app" } });
  assert.deepEqual(machineAuthModes(noUrl.secrets, filled?.secrets), ["app", "app"]);

  const withUrl = collect(TUNNEL_FLAGS, { ...OWN_APP_ENV, PROPR_GH_RELAY_TOKEN: "existing", PROPR_GH_RELAY_URL: "https://relay.example/v1" });
  const pinned = await resolveFlyRelaySecrets(withUrl.options, withUrl.secrets, context, deps);
  assert.deepEqual(pinned, { secrets: { GH_AUTH_MODE: "app" } });
  assert.deepEqual(machineAuthModes(withUrl.secrets, pinned?.secrets), ["app", "app"]);

  // --no-relay only stops enrollment; the existing token still serves Connect next to the own App.
  const noRelay = collect({ ...TUNNEL_FLAGS, relay: false }, { ...OWN_APP_ENV, PROPR_GH_RELAY_TOKEN: "existing" });
  const kept = await resolveFlyRelaySecrets(noRelay.options, noRelay.secrets, context, deps);
  assert.deepEqual(machineAuthModes(noRelay.secrets, kept?.secrets), ["app", "app"]);
  assert.equal(calls.enrolled.length, 0);
});

test("own App + Connect with an existing relay token: an explicit GH_AUTH_MODE is kept", async () => {
  const { deps } = stubDeps();
  const context = { connect: true, label: "l" };
  for (const mode of ["relay", "app"]) {
    const noUrl = collect(TUNNEL_FLAGS, { ...OWN_APP_ENV, PROPR_GH_RELAY_TOKEN: "existing", GH_AUTH_MODE: mode });
    const filled = await resolveFlyRelaySecrets(noUrl.options, noUrl.secrets, context, deps);
    assert.deepEqual(filled, { secrets: { PROPR_GH_RELAY_URL: DEFAULT_PROPR_GH_RELAY_URL } });
    assert.deepEqual(machineAuthModes(noUrl.secrets, filled?.secrets), [mode, mode]);

    const withUrl = collect(TUNNEL_FLAGS, { ...OWN_APP_ENV, PROPR_GH_RELAY_TOKEN: "existing", PROPR_GH_RELAY_URL: "https://relay.example/v1", GH_AUTH_MODE: mode });
    assert.equal(await resolveFlyRelaySecrets(withUrl.options, withUrl.secrets, context, deps), undefined);
  }
});

test("without Connect an own App still suppresses automatic enrollment", async () => {
  const { plan, secrets, options } = collect({ spritesToken: "sp" }, OWN_APP_ENV);
  assert.equal(plan.tunnel, undefined);
  const { deps, calls } = stubDeps();
  assert.equal(await resolveFlyRelaySecrets(options, secrets, { connect: false, githubToken: "gh", label: "l" }, deps), undefined);
  assert.equal(calls.enrolled.length, 0);
  // Without Connect the deploy adds no relay credentials, so the stack's own auth inference stands.
  const withToken = collect({ spritesToken: "sp" }, { ...OWN_APP_ENV, PROPR_GH_RELAY_TOKEN: "existing" });
  assert.equal(await resolveFlyRelaySecrets(withToken.options, withToken.secrets, { connect: false, label: "l" }, deps), undefined);
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
