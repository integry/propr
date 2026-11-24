/**
 * Consecutive `propr deploy fly` runs against one Fly app. Fly secrets are
 * only ever added or replaced, so every run's GitHub auth has to hold up
 * against what earlier runs left behind. Run with:
 * `npx tsx --test src/commands/deploy/flyRedeploy.test.ts` (from packages/cli).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_PROPR_GH_RELAY_URL, resolveGithubAuthMode } from "@propr/shared";
import { deployPreparedFly, prepareFlyDeploy, type DeployFlyOptions } from "../deployFly.js";
import type { FlyDeployTarget } from "./flyDeployRunner.js";
import { buildAppEnv } from "./flyMachineConfig.js";
import type { FlyRelayDeps } from "./flyRelay.js";

const IMAGES = { app: "propr/app:0.9.3", redis: "redis:7-alpine", cloudflared: "cloudflare/cloudflared:2024.12.2" };
const OAUTH_ENV = { GH_OAUTH_CLIENT_ID: "Iv1.client", GH_OAUTH_CLIENT_SECRET: "oauth-secret" };
const OWN_APP_ENV = { ...OAUTH_ENV, GH_APP_ID: "42", GH_INSTALLATION_ID: "777", HOST_GH_PRIVATE_KEY: "/keys/app.pem" };

/** A Fly app as the deploy sees it: setSecrets adds or replaces, nothing is ever removed. */
function flyApp() {
  const secrets: Record<string, string> = {};
  let machineEnv: Record<string, string> = {};
  const target: FlyDeployTarget = {
    kind: "machines-api",
    async ensureApp() { return Object.keys(secrets).length === 0; },
    async ensureVolume() { return { id: "vol_1", created: false, sizeGb: 1 }; },
    async extendVolume() { throw new Error("not expected"); },
    async secretNames() { return Object.keys(secrets); },
    async setSecrets(_app, values) { Object.assign(secrets, values); },
    async deploy(plan) {
      // The Machine sees every app secret plus the generated plain env.
      machineEnv = { ...secrets, ...buildAppEnv(plan) };
      return "deployed";
    },
  };
  return { target, secrets, machineEnv: () => machineEnv };
}

const relayDeps: FlyRelayDeps = {
  discoverInstallationId: async () => "9001",
  enrollRelayToken: async () => ({ token: "shared-relay-token" }),
};

/** One run, sequenced as runDeployFly sequences it. */
async function deploy(app: ReturnType<typeof flyApp>, flags: Omit<DeployFlyOptions, "app">, envFile: Record<string, string>, githubToken?: string) {
  const options = { app: "my-propr", spritesToken: "sp", ...flags };
  const prepared = prepareFlyDeploy(options, IMAGES, envFile, githubToken, () => "-----BEGIN KEY-----\n");
  const context = { githubToken, label: "fly:my-propr@h", generatedSecrets: { SESSION_SECRET: "s" } };
  await deployPreparedFly(prepared, options, app.target, context, () => {}, relayDeps);
  return app.machineEnv();
}

/** GitHub API auth as both consumers resolve it: the API reads PROPR_GH_RELAY_URL as is, core defaults it. */
function authModes(env: Record<string, string>) {
  return [env.PROPR_GH_RELAY_URL, env.PROPR_GH_RELAY_URL?.trim() || DEFAULT_PROPR_GH_RELAY_URL].map((relayUrl) => resolveGithubAuthMode({
    ghAuthMode: env.GH_AUTH_MODE,
    relayUrl,
    relayToken: env.PROPR_GH_RELAY_TOKEN,
    appId: env.GH_APP_ID,
    privateKeyPath: env.GH_PRIVATE_KEY_PATH,
    installationId: env.GH_INSTALLATION_ID,
  }).mode);
}

test("redeploying a relay-enrolled app with an own App switches GitHub API auth to that App", async () => {
  const app = flyApp();
  const first = await deploy(app, {}, OAUTH_ENV, "gh");
  assert.equal(first.GH_AUTH_MODE, "relay");
  assert.equal(first.GH_INSTALLATION_ID, "9001");
  assert.deepEqual(authModes(first), ["relay", "relay"]);

  // Same Fly app, now with an own App: no Connect, no --relay, no GH_AUTH_MODE in the stack.
  const second = await deploy(app, {}, OWN_APP_ENV, "gh");
  assert.equal(second.GH_AUTH_MODE, "app");
  assert.equal(second.GH_INSTALLATION_ID, "777");
  assert.deepEqual(authModes(second), ["app", "app"]);
  // The earlier relay token is still on the app, inert next to the pinned mode.
  assert.equal(second.PROPR_GH_RELAY_TOKEN, "shared-relay-token");
});

test("redeploying an own-App app with relay credentials switches GitHub API auth to the relay", async () => {
  const app = flyApp();
  const first = await deploy(app, {}, OWN_APP_ENV);
  assert.deepEqual(authModes(first), ["app", "app"]);

  const second = await deploy(app, {}, { ...OAUTH_ENV, PROPR_GH_RELAY_TOKEN: "stack-relay-token", GH_INSTALLATION_ID: "321" });
  assert.equal(second.GH_AUTH_MODE, "relay");
  assert.equal(second.PROPR_GH_RELAY_TOKEN, "stack-relay-token");
  assert.equal(second.GH_INSTALLATION_ID, "321");
  assert.deepEqual(authModes(second), ["relay", "relay"]);

  // An enrollment on a later run binds its own installation again.
  const third = await deploy(app, {}, OAUTH_ENV, "gh");
  assert.equal(third.GH_AUTH_MODE, "relay");
  assert.equal(third.GH_INSTALLATION_ID, "9001");
});

test("an own App without GH_INSTALLATION_ID never pairs with the installation an earlier enrollment left", async () => {
  const app = flyApp();
  await deploy(app, {}, OAUTH_ENV, "gh");
  const before = { ...app.secrets };
  const { GH_INSTALLATION_ID: _drop, ...noInstallation } = OWN_APP_ENV;
  await assert.rejects(deploy(app, {}, noInstallation, "gh"), /no GH_INSTALLATION_ID/);
  assert.deepEqual(app.secrets, before, "nothing was uploaded");
});

test("a run without GitHub credentials leaves the earlier relay enrollment in charge", async () => {
  const app = flyApp();
  await deploy(app, {}, OAUTH_ENV, "gh");
  const second = await deploy(app, {}, OAUTH_ENV);
  assert.equal(second.GH_AUTH_MODE, "relay");
  assert.deepEqual(authModes(second), ["relay", "relay"]);
});
