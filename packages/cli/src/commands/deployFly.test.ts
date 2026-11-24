/**
 * `propr deploy fly` option handling. Run with:
 * `npx tsx --test src/commands/deployFly.test.ts` (from packages/cli).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { collectFlySecrets, createDeployCommand, parseIdleShutdownAfter, resolveFlyDeployPlan } from "./deployFly.js";
import { FLY_GH_PRIVATE_KEY_SECRET } from "./deploy/flyMachineConfig.js";

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

test("invalid inputs are rejected before any Fly call", () => {
  assert.throws(() => resolveFlyDeployPlan({ app: "Bad_Name" }, IMAGES), /lowercase/);
  assert.throws(() => resolveFlyDeployPlan({ app: "a1", agentRuntime: "podman" }, IMAGES), /--agent-runtime/);
  assert.throws(() => resolveFlyDeployPlan({ app: "a1", memory: "1gb" }, IMAGES), /--memory/);
  assert.throws(() => resolveFlyDeployPlan({ app: "a1", volume: "bad-name" }, IMAGES), /volume name/);
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
