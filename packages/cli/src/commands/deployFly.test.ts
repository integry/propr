/**
 * `propr deploy fly` option handling. Run with:
 * `npx tsx --test src/commands/deployFly.test.ts` (from packages/cli).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertFlyIdleShutdownSupported,
  collectFlySecrets,
  createDeployCommand,
  FLY_IDLE_SHUTDOWN_SUPPORTED,
  FLY_WORKER_AGENT_RUNTIMES,
  parseIdleShutdownAfter,
  prepareFlyDeploy,
  resolveFlyDeployPlan,
  type DeployFlyOptions,
} from "./deployFly.js";
import {
  buildAppEnv,
  buildMachineConfig,
  FLY_GH_PRIVATE_KEY_SECRET,
  renderFlyMachineConfigJson,
  renderFlyToml,
  type JsonObject,
} from "./deploy/flyMachineConfig.js";

const IMAGES = { app: "propr/app:0.9.3", redis: "redis:7-alpine", cloudflared: "cloudflare/cloudflared:2024.12.2" };

test("defaults: 1 GB shared-cpu-1x, 1 GB volume, manifest images, Sprites agents, always on", () => {
  const plan = resolveFlyDeployPlan({ app: "my-propr" }, IMAGES);
  assert.equal(plan.org, "personal");
  assert.equal(plan.region, "iad");
  assert.equal(plan.memoryMb, 1024);
  assert.equal(plan.cpus, 1);
  assert.equal(plan.cpuKind, "shared");
  assert.equal(plan.volumeSizeGb, 1);
  assert.equal(plan.images.app, "propr/app:0.9.3");
  assert.equal(plan.images.redis, "redis:7-alpine");
  assert.equal(plan.agentRuntime, "sprites");
  assert.equal(plan.idleShutdownAfter, undefined);
  assert.equal(plan.legacyDocker, false);
});

test("legacy Docker forces the docker runtime and larger defaults", () => {
  const plan = resolveFlyDeployPlan({ app: "my-propr", legacyDocker: true }, IMAGES);
  assert.equal(plan.agentRuntime, "docker");
  assert.equal(plan.memoryMb, 2048);
  assert.equal(plan.volumeSizeGb, 20);
  assert.throws(() => resolveFlyDeployPlan({ app: "a1", legacyDocker: true, memory: "1024" }, IMAGES), /at least 2048 MB/);
  assert.throws(() => resolveFlyDeployPlan({ app: "a1", legacyDocker: true, volumeSize: "3" }, IMAGES), /--volume-size 10/);
  assert.throws(() => resolveFlyDeployPlan({ app: "a1", agentRuntime: "docker" }, IMAGES), /--legacy-docker/);
  assert.throws(() => resolveFlyDeployPlan({ app: "a1", legacyDocker: true, agentRuntime: "sprites" }, IMAGES), /Docker runtime/);
});

test("agent runtimes the worker cannot start are refused before anything is written or sent to Fly", () => {
  // The worker waits for the Docker agent image before claiming capacity; without a Docker daemon it never would.
  assert.deepEqual(FLY_WORKER_AGENT_RUNTIMES, ["docker"]);
  const oauth = { GH_OAUTH_CLIENT_ID: "Iv1.client", GH_OAUTH_CLIENT_SECRET: "oauth-secret", PROPR_GH_RELAY_TOKEN: "rt" };
  for (const flags of [{}, { agentRuntime: "sprites" }, { agentRuntime: "fly-machines" }, { dryRun: true }]) {
    assert.throws(
      () => prepareFlyDeploy({ app: "my-propr", spritesToken: "sp", agentFlyToken: "fly", ...flags }, IMAGES, oauth, "gh"),
      (error: Error) => /Agents on (sprites|fly-machines) are not supported by this release/.test(error.message) && /--legacy-docker/.test(error.message),
      JSON.stringify(flags),
    );
  }
  const prepared = prepareFlyDeploy({ app: "my-propr", legacyDocker: true }, IMAGES, oauth, "gh");
  assert.equal(prepared.plan.agentRuntime, "docker");
});

test("invalid inputs are rejected before any Fly call", () => {
  assert.throws(() => resolveFlyDeployPlan({ app: "Bad_Name" }, IMAGES), /lowercase/);
  assert.throws(() => resolveFlyDeployPlan({ app: "a1", agentRuntime: "podman" }, IMAGES), /--agent-runtime/);
  assert.throws(() => resolveFlyDeployPlan({ app: "a1", memory: "1gb" }, IMAGES), /--memory/);
  assert.throws(() => resolveFlyDeployPlan({ app: "a1", volume: "bad-name" }, IMAGES), /volume name/);
});

test("idle shutdown is refused before anything is written or sent to Fly: the app image cannot stop an idle Machine", () => {
  // No idle detector or /wake route in the app image yet (#3770): the flag would only swap the restart policy.
  assert.equal(FLY_IDLE_SHUTDOWN_SUPPORTED, false);
  const oauth = { GH_OAUTH_CLIENT_ID: "Iv1.client", GH_OAUTH_CLIENT_SECRET: "oauth-secret", PROPR_GH_RELAY_TOKEN: "rt" };
  const refused = (error: Error) =>
    /--idle-shutdown is not supported by this release/.test(error.message) && /#3770/.test(error.message) && /always on/.test(error.message);
  const flagSets: Array<Partial<DeployFlyOptions>> = [{ idleShutdown: true }, { idleShutdown: "15m" }, { idleShutdown: "2h", dryRun: true }];
  for (const flags of flagSets) {
    assert.throws(() => prepareFlyDeploy({ app: "my-propr", legacyDocker: true, ...flags }, IMAGES, oauth, "gh"), refused, JSON.stringify(flags));
  }
  // The bare flag as commander parses it reaches the same refusal.
  const fly = createDeployCommand().commands.find((c) => c.name() === "fly");
  assert.ok(fly);
  fly.parseOptions(["--app", "my-propr", "--legacy-docker", "--idle-shutdown", "--dry-run"]);
  const parsed = fly.opts() as DeployFlyOptions;
  assert.equal(parsed.idleShutdown, true);
  assert.throws(() => prepareFlyDeploy(parsed, IMAGES, oauth, "gh"), refused);
  // A malformed duration still names the accepted range.
  assert.throws(() => prepareFlyDeploy({ app: "my-propr", legacyDocker: true, idleShutdown: "soon" }, IMAGES, oauth, "gh"), /1m to 24h/);

  // Without the flag the Machine is always on in both generated forms: restart always, never scaled to zero, no idle env.
  for (const idleShutdown of [undefined, false]) {
    const { plan } = prepareFlyDeploy({ app: "my-propr", legacyDocker: true, idleShutdown }, IMAGES, oauth, "gh");
    assert.equal(plan.idleShutdownAfter, undefined);
    const config = buildMachineConfig(plan);
    assert.deepEqual(config.restart, { policy: "always" });
    assert.equal((config.services as JsonObject[])[0].min_machines_running, 1);
    assert.equal(buildAppEnv(plan).PROPR_IDLE_SHUTDOWN, undefined);
    assert.equal(buildAppEnv(plan).PROPR_IDLE_SHUTDOWN_AFTER, undefined);
    const toml = renderFlyToml(plan);
    assert.match(toml, /policy = "always"/);
    assert.match(toml, /min_machines_running = 1/);
    assert.doesNotMatch(toml, /idle|decides when to stop/i);
    assert.doesNotMatch(renderFlyMachineConfigJson(plan), /PROPR_IDLE_SHUTDOWN/);
  }
  // The gate is the one switch to flip once the app image exits 0 when idle.
  assert.doesNotThrow(() => assertFlyIdleShutdownSupported({ idleShutdownAfter: "15m" }, true));
  assert.doesNotThrow(() => assertFlyIdleShutdownSupported({ idleShutdownAfter: undefined }));
});

test("idle shutdown is off unless given; bare flag means 15m", () => {
  assert.equal(parseIdleShutdownAfter(undefined), undefined);
  assert.equal(parseIdleShutdownAfter(true), "15m");
  assert.equal(parseIdleShutdownAfter("2h"), "2h");
  assert.throws(() => parseIdleShutdownAfter("30s"), /1m to 24h/);
  assert.throws(() => parseIdleShutdownAfter("25h"), /1m to 24h/);
  assert.throws(() => parseIdleShutdownAfter("soon"), /1m to 24h/);
});

test("secrets: stack .env minus tunnel tokens, GitHub key as base64, Connect tunnel from flags", () => {
  const plan = resolveFlyDeployPlan({ app: "my-propr" }, IMAGES);
  const { secrets, notes } = collectFlySecrets(
    plan,
    { app: "my-propr", tunnelToken: "cf-token", tunnelUrl: "https://t-abc123.propr.dev", spritesToken: "sp" },
    { SESSION_SECRET: "s", GH_APP_ID: "1", HOST_GH_PRIVATE_KEY: "/keys/app.pem", PROPR_UI_TUNNEL_TOKEN: "local-tunnel" },
    (path) => (path === "/keys/app.pem" ? "-----BEGIN KEY-----\nabc\n" : ""),
  );
  assert.equal(secrets.SESSION_SECRET, "s");
  assert.equal(secrets.GH_APP_ID, "1");
  assert.equal(secrets.HOST_GH_PRIVATE_KEY, undefined);
  assert.equal(Buffer.from(secrets[FLY_GH_PRIVATE_KEY_SECRET], "base64").toString(), "-----BEGIN KEY-----\nabc\n");
  assert.equal(plan.githubAppKey, true);
  assert.equal(secrets.PROPR_UI_TUNNEL_TOKEN, "cf-token");
  assert.equal(secrets.TUNNEL_TOKEN, "cf-token");
  assert.deepEqual(plan.tunnel, { instanceId: "abc123", publicUrl: "https://t-abc123.propr.dev" });
  assert.equal(secrets.SPRITES_TOKEN, "sp");
  assert.ok(notes.some((n) => n.includes("PROPR_UI_TUNNEL_TOKEN")));
});

test("a base64 GitHub App key already in the stack .env wires the key file without a key path", () => {
  const plan = resolveFlyDeployPlan({ app: "my-propr" }, IMAGES);
  const b64 = Buffer.from("-----BEGIN KEY-----\n").toString("base64");
  const { secrets } = collectFlySecrets(plan, { app: "my-propr", spritesToken: "sp" }, { GH_APP_ID: "1", [FLY_GH_PRIVATE_KEY_SECRET]: b64 }, () => {
    throw new Error("no key file should be read");
  });
  assert.equal(secrets[FLY_GH_PRIVATE_KEY_SECRET], b64);
  assert.equal(plan.githubAppKey, true);
  // Without any key the plan stays key-less.
  const bare = resolveFlyDeployPlan({ app: "my-propr" }, IMAGES);
  collectFlySecrets(bare, { app: "my-propr", spritesToken: "sp" }, { GH_APP_ID: "1" });
  assert.equal(bare.githubAppKey, false);
});

test("without a tunnel flag the local tunnel token is not copied and a missing Sprites token is noted", () => {
  const saved = process.env.SPRITES_TOKEN;
  delete process.env.SPRITES_TOKEN;
  try {
    const plan = resolveFlyDeployPlan({ app: "my-propr" }, IMAGES);
    const { secrets, notes } = collectFlySecrets(plan, { app: "my-propr" }, { PROPR_UI_TUNNEL_TOKEN: "local", TUNNEL_TOKEN: "x" });
    assert.deepEqual(secrets, {});
    assert.equal(plan.tunnel, undefined);
    assert.ok(notes.some((n) => n.includes("No Sprites token")));
  } finally {
    if (saved !== undefined) process.env.SPRITES_TOKEN = saved;
  }
});

test("command registers `deploy fly` with tri-state relay and env-file flags", () => {
  const deploy = createDeployCommand();
  const fly = deploy.commands.find((c) => c.name() === "fly");
  assert.ok(fly);
  const flags = fly.options.map((o) => o.long);
  for (const flag of ["--app", "--org", "--token", "--idle-shutdown", "--legacy-docker", "--relay", "--no-relay", "--env-file", "--no-env-file", "--dry-run"]) {
    assert.ok(flags.includes(flag), `has ${flag}`);
  }
  fly.parseOptions(["--app", "x"]);
  const parsed = fly.opts();
  assert.equal(parsed.relay, undefined);
  assert.equal(parsed.envFile, undefined);
});

test("stack .env values for deployment-owned settings are not uploaded with a legacy Docker plan", () => {
  const plan = resolveFlyDeployPlan({ app: "my-propr", legacyDocker: true }, IMAGES);
  const { secrets } = collectFlySecrets(plan, { app: "my-propr" }, {
    PROPR_INDEXING: "separate",
    GIT_CLONES_BASE_PATH: "/home/me/clones",
    GIT_WORKTREES_BASE_PATH: "/home/me/worktrees",
    PROPR_EGRESS_SOCKET_DIR: "/home/me/egress",
    ANTHROPIC_API_KEY: "k",
  });
  assert.deepEqual(secrets, { ANTHROPIC_API_KEY: "k" });
});
