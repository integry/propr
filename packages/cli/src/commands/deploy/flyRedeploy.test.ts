/**
 * Consecutive `propr deploy fly` runs against one Fly app. Fly secrets are
 * only ever added or replaced, so every run's GitHub auth has to hold up
 * against what earlier runs left behind. Run with:
 * `npx tsx --test src/commands/deploy/flyRedeploy.test.ts` (from packages/cli).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_PROPR_GH_RELAY_URL, parseTruthyEnvValue, resolveGithubAuthMode, validateIntakeModePrerequisites, type GithubEventIntakeMode } from "@propr/shared";
import { deployPreparedFly, prepareFlyDeploy, type DeployFlyOptions } from "../deployFly.js";
import type { FlyDeployTarget } from "./flyDeployRunner.js";
import { buildAppEnv, buildMachineConfig, FLY_GH_PRIVATE_KEY_PATH, FLY_GH_PRIVATE_KEY_SECRET } from "./flyMachineConfig.js";
import type { FlyRelayDeps } from "./flyRelay.js";

const IMAGES = { app: "propr/app:0.9.3", redis: "redis:7-alpine", cloudflared: "cloudflare/cloudflared:2024.12.2" };
const OAUTH_ENV = { GH_OAUTH_CLIENT_ID: "Iv1.client", GH_OAUTH_CLIENT_SECRET: "oauth-secret" };
const OWN_APP_ENV = { ...OAUTH_ENV, GH_APP_ID: "42", GH_INSTALLATION_ID: "777", HOST_GH_PRIVATE_KEY: "/keys/app.pem" };
const TUNNEL_FLAGS = { tunnelToken: "cf-token", tunnelUrl: "https://t-abc123.propr.dev" };
const KEY_FILE_DECLARATION = [{ guest_path: FLY_GH_PRIVATE_KEY_PATH, secret_name: FLY_GH_PRIVATE_KEY_SECRET, mode: 0o400 }];

/** A Fly app as the deploy sees it: setSecrets adds or replaces, nothing is ever removed. */
function flyApp() {
  const secrets: Record<string, string> = {};
  let machineEnv: Record<string, string> = {};
  let appFiles: unknown;
  const target: FlyDeployTarget = {
    kind: "machines-api",
    async ensureApp() { return Object.keys(secrets).length === 0; },
    async ensureVolume() { return { id: "vol_1", created: false, sizeGb: 1 }; },
    async extendVolume() { throw new Error("not expected"); },
    async secretNames() { return Object.keys(secrets); },
    async setSecrets(_app, values) { Object.assign(secrets, values); },
    async deploy(plan) {
      // As on Fly: a container in a multi-container Machine sees only the app
      // secrets it lists, plus the generated plain env.
      const containers = buildMachineConfig(plan, "vol_1").containers as Array<{ name: string; files?: unknown; secrets?: Array<{ env_var: string; name: string }> }>;
      const app = containers.find((c) => c.name === "app");
      const visible = Object.fromEntries((app?.secrets ?? []).filter((s) => s.name in secrets).map((s) => [s.env_var, secrets[s.name]]));
      machineEnv = { ...visible, ...buildAppEnv(plan) };
      appFiles = app?.files;
      return "deployed";
    },
  };
  return { target, secrets, machineEnv: () => machineEnv, appFiles: () => appFiles };
}

const relayDeps: FlyRelayDeps = {
  discoverInstallationId: async () => "9001",
  enrollRelayToken: async () => ({ token: "shared-relay-token" }),
};

/** One run, sequenced as runDeployFly sequences it. */
async function deploy(app: ReturnType<typeof flyApp>, flags: Omit<DeployFlyOptions, "app">, envFile: Record<string, string>, githubToken?: string, deps: FlyRelayDeps = relayDeps) {
  const options = { app: "my-propr", spritesToken: "sp", ...flags };
  const prepared = prepareFlyDeploy(options, IMAGES, envFile, githubToken, () => "-----BEGIN KEY-----\n");
  const context = { githubToken, label: "fly:my-propr@h", generatedSecrets: { SESSION_SECRET: "s" } };
  await deployPreparedFly(prepared, options, app.target, context, () => {}, deps);
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

test("redeploying an own-App app without new GitHub credentials keeps the App key wired into the Machine", async () => {
  const app = flyApp();
  const first = await deploy(app, {}, OWN_APP_ENV);
  assert.equal(first.GH_AUTH_MODE, "app");
  assert.equal(first.GH_PRIVATE_KEY_PATH, FLY_GH_PRIVATE_KEY_PATH);
  assert.deepEqual(authModes(first), ["app", "app"]);

  // OAuth browser sign-in only, no key file, no `propr login`: the earlier App stays in charge.
  const second = await deploy(app, {}, OAUTH_ENV);
  assert.equal(second.GH_AUTH_MODE, "app");
  assert.equal(second.GH_APP_ID, "42");
  assert.equal(second.GH_INSTALLATION_ID, "777");
  assert.equal(second.GH_PRIVATE_KEY_PATH, FLY_GH_PRIVATE_KEY_PATH, "the env still points at the key file");
  assert.deepEqual(app.appFiles(), [{ guest_path: FLY_GH_PRIVATE_KEY_PATH, secret_name: FLY_GH_PRIVATE_KEY_SECRET, mode: 0o400 }], "the key file is still declared");
  assert.deepEqual(authModes(second), ["app", "app"]);
});

test("a first deploy with only a base64 App key in the stack .env wires that key into the Machine", async () => {
  // No key file, no HOST_GH_PRIVATE_KEY: the .env carries the key the way an earlier upload stored it.
  const { HOST_GH_PRIVATE_KEY: _path, ...noKeyFile } = OWN_APP_ENV;
  const b64Env = { ...noKeyFile, [FLY_GH_PRIVATE_KEY_SECRET]: Buffer.from("-----BEGIN KEY-----\n").toString("base64") };
  const app = flyApp();
  const env = await deploy(app, {}, b64Env, "gh");
  assert.equal(env.GH_AUTH_MODE, "app");
  assert.equal(env.GH_INSTALLATION_ID, "777");
  assert.equal(env.GH_PRIVATE_KEY_PATH, FLY_GH_PRIVATE_KEY_PATH, "the env points at the key file");
  assert.deepEqual(app.appFiles(), KEY_FILE_DECLARATION, "the key file is declared from this run's upload");
  assert.equal(app.secrets[FLY_GH_PRIVATE_KEY_SECRET], b64Env[FLY_GH_PRIVATE_KEY_SECRET]);
  assert.deepEqual(authModes(env), ["app", "app"]);

  // The same .env on a Connect deploy keeps the own App for API auth with the key wired in.
  const connectApp = flyApp();
  const connectEnv = await deploy(connectApp, TUNNEL_FLAGS, b64Env, "gh");
  assert.equal(connectEnv.GH_AUTH_MODE, "app");
  assert.equal(connectEnv.GH_PRIVATE_KEY_PATH, FLY_GH_PRIVATE_KEY_PATH);
  assert.deepEqual(connectApp.appFiles(), KEY_FILE_DECLARATION);
});

test("a demo-mode app redeployed with a GitHub OAuth client leaves demo mode", async () => {
  const app = flyApp();
  const first = await deploy(app, {}, { PROPR_DEMO_MODE: "true" });
  assert.equal(parseTruthyEnvValue(first.PROPR_DEMO_MODE), true);

  // Demo mode has nothing to ingest: the passive intake keeps the daemon up without a relay token.
  assert.equal(first.GITHUB_EVENT_INTAKE_MODE, "direct_webhook");
  assert.equal(first.SESSION_SECRET, "s", "the app container sees the app secrets");

  // PROPR_DEMO_MODE dropped from the local .env; Fly still holds the earlier value.
  const second = await deploy(app, {}, OAUTH_ENV, "gh");
  assert.equal(second.PROPR_DEMO_MODE, "false");
  assert.equal(parseTruthyEnvValue(second.PROPR_DEMO_MODE), false, "the API no longer boots in demo mode");
  assert.equal(second.GH_OAUTH_CLIENT_ID, "Iv1.client");
  assert.equal(second.GITHUB_EVENT_INTAKE_MODE, "routing_websocket", "the enrolled relay token carries events");
});

test("secrets left by an earlier deploy stay visible to the app container", async () => {
  const app = flyApp();
  await deploy(app, {}, { ...OAUTH_ENV, ANTHROPIC_API_KEY: "sk-earlier" }, "gh");
  // The next run's .env no longer has the key; Fly still does, and the Machine must see it.
  const env = await deploy(app, {}, OAUTH_ENV, "gh");
  assert.equal(env.ANTHROPIC_API_KEY, "sk-earlier");
  assert.equal(env.PROPR_GH_RELAY_TOKEN, "shared-relay-token");
});

test("a --no-relay deploy without GitHub credentials stops before uploading secrets", async () => {
  const app = flyApp();
  await assert.rejects(deploy(app, { relay: false }, OAUTH_ENV, "gh"), /no GitHub credentials, so its daemon could not start/);
  assert.deepEqual(app.secrets, {});
});

test("an own GitHub App without a relay token polls, or takes direct webhooks with a webhook secret", async () => {
  const polling = await deploy(flyApp(), { relay: false }, OWN_APP_ENV);
  assert.equal(polling.GITHUB_EVENT_INTAKE_MODE, "polling");
  const webhook = await deploy(flyApp(), { relay: false }, { ...OWN_APP_ENV, GH_WEBHOOK_SECRET: "whsec" });
  assert.equal(webhook.GITHUB_EVENT_INTAKE_MODE, "direct_webhook");
  // Connect enrolls a relay token for sign-in, but the own App keeps API auth, so routing_websocket (relay auth only) is not picked.
  const connect = await deploy(flyApp(), TUNNEL_FLAGS, OWN_APP_ENV, "gh");
  assert.equal(connect.GH_AUTH_MODE, "app");
  assert.equal(connect.GITHUB_EVENT_INTAKE_MODE, "polling");
});

test("a demo-mode app redeployed with Connect leaves demo mode", async () => {
  const app = flyApp();
  await deploy(app, {}, { PROPR_DEMO_MODE: "true" });
  const second = await deploy(app, TUNNEL_FLAGS, {}, "gh");
  assert.equal(second.PROPR_DEMO_MODE, "false");
  assert.equal(parseTruthyEnvValue(second.PROPR_DEMO_MODE), false);
  assert.equal(second.PROPR_WEB_AUTH_MODE, "connect");
});

/** The daemon's boot check, under the auth mode the Machine env resolves to. */
function intakeErrors(env: Record<string, string>) {
  return authModes(env).flatMap((authMode) => validateIntakeModePrerequisites({
    intakeMode: env.GITHUB_EVENT_INTAKE_MODE as GithubEventIntakeMode,
    authMode,
    routingUrl: env.PROPR_ROUTING_URL,
    relayUrl: env.PROPR_GH_RELAY_URL,
    relayToken: env.PROPR_GH_RELAY_TOKEN,
    webhookSecret: env.GH_WEBHOOK_SECRET,
  }).errors);
}

test("an own App + Connect app redeployed with only an OAuth client keeps App auth and an intake that starts under it", async () => {
  const extras: Record<string, string>[] = [{}, { GH_WEBHOOK_SECRET: "whsec" }];
  for (const extra of extras) {
    const app = flyApp();
    const first = await deploy(app, TUNNEL_FLAGS, { ...OWN_APP_ENV, ...extra }, "gh");
    assert.equal(first.GH_AUTH_MODE, "app");
    assert.equal(first.PROPR_GH_RELAY_TOKEN, "shared-relay-token", "Connect sign-in got a relay token");
    const intake = first.GITHUB_EVENT_INTAKE_MODE;
    assert.deepEqual(intakeErrors(first), []);

    // No App, no tunnel flags, no local login: GH_AUTH_MODE=app stays on Fly,
    // next to the relay token, so routing_websocket would fail the daemon.
    const second = await deploy(app, {}, OAUTH_ENV);
    assert.equal(second.GH_AUTH_MODE, "app");
    assert.deepEqual(authModes(second), ["app", "app"]);
    assert.equal(second.GITHUB_EVENT_INTAKE_MODE, intake, "the earlier intake is kept");
    assert.deepEqual(intakeErrors(second), []);
  }
});

test("a demo deploy with a GitHub login and no shared-App installation skips relay enrollment", async () => {
  const noInstallation: FlyRelayDeps = {
    discoverInstallationId: async () => { throw new Error("no ProPR App installation found"); },
    enrollRelayToken: async () => { throw new Error("not expected"); },
  };
  const env = await deploy(flyApp(), {}, { PROPR_DEMO_MODE: "true" }, "gh", noInstallation);
  assert.equal(parseTruthyEnvValue(env.PROPR_DEMO_MODE), true);
  assert.equal(env.PROPR_GH_RELAY_TOKEN, undefined);
  assert.equal(env.GITHUB_EVENT_INTAKE_MODE, "direct_webhook");
  // An explicit --relay still enrolls, and fails here without an installation.
  await assert.rejects(deploy(flyApp(), { relay: true }, { PROPR_DEMO_MODE: "true" }, "gh", noInstallation), /no ProPR App installation found/);
});
