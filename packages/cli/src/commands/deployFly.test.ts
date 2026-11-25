/**
 * `propr deploy fly` option handling. Run with:
 * `npx tsx --test src/commands/deployFly.test.ts` (from packages/cli).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  collectFlySecrets,
  createDeployCommand,
  describeFlyRootfs,
  parseIdleShutdownAfter,
  prepareFlyDeploy,
  resolveFlyDeployPlan,
  type DeployFlyOptions,
} from "./deployFly.js";
import {
  buildAppEnv,
  buildMachineConfig,
  FLY_GH_PRIVATE_KEY_SECRET,
  FLY_MACHINE_STOP_TOKEN_SECRET,
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

test("legacy Docker forces the docker runtime, a persistent rootfs for images, and the default 1 GB volume", () => {
  const plan = resolveFlyDeployPlan({ app: "my-propr", legacyDocker: true }, IMAGES);
  assert.equal(plan.agentRuntime, "docker");
  assert.equal(plan.memoryMb, 2048);
  assert.equal(plan.volumeSizeGb, 1);
  assert.equal(plan.rootfsSizeGb, 20);
  assert.equal(resolveFlyDeployPlan({ app: "a1", legacyDocker: true, rootfsSize: "30", volumeSize: "3" }, IMAGES).rootfsSizeGb, 30);
  assert.equal(resolveFlyDeployPlan({ app: "a1", legacyDocker: true, volumeSize: "3" }, IMAGES).volumeSizeGb, 3);
  assert.equal(resolveFlyDeployPlan({ app: "a1" }, IMAGES).rootfsSizeGb, undefined);
  assert.throws(() => resolveFlyDeployPlan({ app: "a1", legacyDocker: true, memory: "512" }, IMAGES), /at least 1024 MB/);
  assert.equal(resolveFlyDeployPlan({ app: "a1", legacyDocker: true, memory: "1024" }, IMAGES).memoryMb, 1024);
  assert.throws(() => resolveFlyDeployPlan({ app: "a1", legacyDocker: true, rootfsSize: "5" }, IMAGES), /--rootfs-size 10 or more/);
  assert.throws(() => resolveFlyDeployPlan({ app: "a1", rootfsSize: "20" }, IMAGES), /needs --legacy-docker/);
  assert.throws(() => resolveFlyDeployPlan({ app: "a1", agentRuntime: "docker" }, IMAGES), /--legacy-docker/);
  assert.throws(() => resolveFlyDeployPlan({ app: "a1", legacyDocker: true, agentRuntime: "sprites" }, IMAGES), /Docker runtime/);
});

test("prepares both remote runtimes and defaults to Sprites with idle shutdown off", () => {
  const env = { PROPR_ADMIN_USERS: "owner", PROPR_DEMO_MODE: "true" };
  for (const agentRuntime of [undefined, "sprites", "fly-machines"]) {
    const { plan } = prepareFlyDeploy({ app: "my-propr", agentRuntime }, IMAGES, env, undefined);
    assert.equal(plan.agentRuntime, agentRuntime ?? "sprites");
    assert.equal(plan.idleShutdownAfter, undefined);
    assert.equal(buildAppEnv(plan).PROPR_INSTANCE_ID, plan.app);
    assert.equal(buildAppEnv(plan).PROPR_MANAGED_CREDENTIALS_DIR, "/usr/src/app/data/agent-credentials");
  }
});

test("Fly Machines accepts the agent app token from the environment file or flag", () => {
  const options = { app: "my-propr", agentRuntime: "fly-machines" };
  const plan = resolveFlyDeployPlan(options, IMAGES);
  const env = { PROPR_FLY_API_TOKEN: "from-file" };
  assert.deepEqual(collectFlySecrets(plan, options, env), { secrets: env, notes: [] });
  const { secrets } = collectFlySecrets(plan, { ...options, agentFlyToken: "from-flag" }, env);
  assert.equal(secrets.PROPR_FLY_API_TOKEN, "from-flag");
});

test("requires an administrator before provisioning", () => {
  for (const admin of ["", " , "]) {
    assert.throws(() => prepareFlyDeploy({ app: "my-propr" }, IMAGES, { PROPR_ADMIN_USERS: admin }, undefined), /PROPR_ADMIN_USERS/);
  }
});

test("invalid inputs are rejected before any Fly call", () => {
  assert.throws(() => resolveFlyDeployPlan({ app: "Bad_Name" }, IMAGES), /lowercase/);
  assert.throws(() => resolveFlyDeployPlan({ app: "a1", agentRuntime: "podman" }, IMAGES), /--agent-runtime/);
  assert.throws(() => resolveFlyDeployPlan({ app: "a1", memory: "1gb" }, IMAGES), /--memory/);
  assert.throws(() => resolveFlyDeployPlan({ app: "a1", volume: "bad-name" }, IMAGES), /volume name/);
});

test("idle shutdown is accepted now that the app image stops the whole Machine when idle", () => {
  // The app image has the idle detector and /wake (#3770) and stops the Machine through the Machines API.
  const oauth = { PROPR_ADMIN_USERS: "owner", GH_OAUTH_CLIENT_ID: "Iv1.client", GH_OAUTH_CLIENT_SECRET: "oauth-secret", PROPR_GH_RELAY_TOKEN: "rt" };
  const flagSets: Array<[Partial<DeployFlyOptions>, string]> = [[{ idleShutdown: true }, "15m"], [{ idleShutdown: "15m" }, "15m"], [{ idleShutdown: "2h", dryRun: true }, "2h"]];
  for (const [flags, after] of flagSets) {
    const { plan } = prepareFlyDeploy({ app: "my-propr", legacyDocker: true, ...flags }, IMAGES, oauth, "gh");
    assert.equal(plan.idleShutdownAfter, after, JSON.stringify(flags));
    assert.equal(buildAppEnv(plan).PROPR_IDLE_SHUTDOWN, "on");
    assert.deepEqual(buildMachineConfig(plan).restart, { policy: "on-failure", max_retries: 10 });
  }
  // The bare flag as commander parses it, with a token for the Machines API backend.
  const fly = createDeployCommand().commands.find((c) => c.name() === "fly");
  assert.ok(fly);
  fly.parseOptions(["--app", "my-propr", "--agent-runtime", "sprites", "--idle-shutdown", "--machine-stop-token", "FlyV1 fm2_given", "--dry-run"]);
  const parsed = fly.opts() as DeployFlyOptions;
  assert.equal(parsed.idleShutdown, true);
  const prepared = prepareFlyDeploy(parsed, IMAGES, oauth, "gh");
  assert.equal(prepared.secrets[FLY_MACHINE_STOP_TOKEN_SECRET], "FlyV1 fm2_given");
  // A stop token without idle shutdown is a mistake, not silently uploaded.
  assert.throws(() => prepareFlyDeploy({ app: "my-propr", legacyDocker: true, machineStopToken: "t" }, IMAGES, oauth, "gh"), /only used with --idle-shutdown/);
  // A stack .env never supplies it: a token for another app would make every idle stop fail.
  assert.equal(FLY_MACHINE_STOP_TOKEN_SECRET in prepareFlyDeploy({ app: "my-propr", legacyDocker: true, idleShutdown: true }, IMAGES, { ...oauth, [FLY_MACHINE_STOP_TOKEN_SECRET]: "other" }, "gh").secrets, false);
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
  for (const flag of ["--app", "--org", "--token", "--idle-shutdown", "--legacy-docker", "--rootfs-size", "--relay", "--no-relay", "--env-file", "--no-env-file", "--dry-run"]) {
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

test("the plan summary (dry run included) shows a legacy plan's persistent rootfs size and its stopped cost", () => {
  const lines = describeFlyRootfs(resolveFlyDeployPlan({ app: "my-propr", legacyDocker: true }, IMAGES));
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^Root fs: +20 GB, persistent/);
  assert.match(lines[1], /^Root fs cost: +\$3\.00\/month while the Machine is stopped \(\$0\.15\/GB-month\)$/);
  assert.match(describeFlyRootfs(resolveFlyDeployPlan({ app: "my-propr", legacyDocker: true, rootfsSize: "40" }, IMAGES))[1], /\$6\.00\/month/);
  assert.deepEqual(describeFlyRootfs(resolveFlyDeployPlan({ app: "my-propr" }, IMAGES)), []);
});
