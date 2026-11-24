/**
 * `propr deploy fly` Machine layout. Run with:
 * `npx tsx --test src/commands/deploy/flyMachineConfig.test.ts` (from packages/cli).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildAppEnv,
  buildMachineConfig,
  FLY_DATA_PATH,
  FLY_DB_FILENAME,
  FLY_GH_PRIVATE_KEY_PATH,
  FLY_GH_PRIVATE_KEY_SECRET,
  renderFlyMachineConfigJson,
  renderFlyToml,
  selectEnvFileSecrets,
  validateFlyAppName,
  validateFlyVolumeName,
  type FlyDeployPlan,
  type JsonObject,
} from "./flyMachineConfig.js";

export function basePlan(overrides: Partial<FlyDeployPlan> = {}): FlyDeployPlan {
  return {
    app: "my-propr",
    org: "personal",
    region: "iad",
    images: { app: "propr/app:0.9.3", redis: "redis:7-alpine", cloudflared: "cloudflare/cloudflared:2024.12.2" },
    cpuKind: "shared",
    cpus: 1,
    memoryMb: 1024,
    volumeName: "propr_data",
    volumeSizeGb: 1,
    agentRuntime: "sprites",
    legacyDocker: false,
    githubAppKey: false,
    ...overrides,
  };
}

function containers(config: JsonObject): JsonObject[] {
  return config.containers as JsonObject[];
}

function container(config: JsonObject, name: string): JsonObject {
  const found = containers(config).find((c) => c.name === name);
  assert.ok(found, `container ${name} exists`);
  return found;
}

test("default Machine: app + redis in one shared-cpu-1x 1 GB Machine, always on", () => {
  const config = buildMachineConfig(basePlan(), "vol_123");
  assert.deepEqual(config.guest, { cpu_kind: "shared", cpus: 1, memory_mb: 1024 });
  assert.deepEqual(containers(config).map((c) => c.name), ["redis", "app"]);
  assert.deepEqual(config.mounts, [{ volume: "vol_123", path: FLY_DATA_PATH }]);
  assert.deepEqual(config.restart, { policy: "always" });
  const [service] = config.services as JsonObject[];
  assert.equal(service.internal_port, 4000);
  assert.equal(service.autostop, "off");
  assert.equal(service.autostart, true);
  assert.equal(service.min_machines_running, 1);

  const app = container(config, "app");
  assert.equal(app.image, "propr/app:0.9.3");
  assert.deepEqual(app.cmd, ["node", "dist/src/allInOne.js"]);
  assert.deepEqual(app.depends_on, [{ name: "redis", condition: "healthy" }]);
  const redis = container(config, "redis");
  const redisCmd = (redis.cmd as string[]).join(" ");
  assert.match(redisCmd, /--bind 127\.0\.0\.1/);
  assert.match(redisCmd, /--dir \/usr\/src\/app\/data\/redis/);
  assert.match(redisCmd, /--appendonly yes/);
  assert.match(redisCmd, /--maxmemory-policy noeviction/);
});

test("app env: SQLite on the volume, Redis on loopback, served UI, Sprites agents", () => {
  const env = buildAppEnv(basePlan());
  assert.equal(env.DB_FILENAME, FLY_DB_FILENAME);
  assert.ok(env.DB_FILENAME.startsWith(`${FLY_DATA_PATH}/`));
  assert.equal(env.REDIS_HOST, "127.0.0.1");
  assert.equal(env.SESSION_REDIS_HOST, "127.0.0.1");
  assert.equal(env.NODE_ENV, "production");
  assert.equal(env.PROPR_CONTAINERIZED, "1");
  assert.equal(env.PROPR_SERVE_UI, "1");
  assert.equal(env.API_PUBLIC_URL, "https://my-propr.fly.dev");
  assert.equal(env.FRONTEND_URL, "https://my-propr.fly.dev");
  assert.equal(env.GH_OAUTH_CALLBACK_URL, "https://my-propr.fly.dev/api/auth/github/callback");
  assert.equal(env.PROPR_AGENT_RUNTIME, "sprites");
  assert.equal(env.SPRITES_CLIENT_SIGNALS, "0");
  assert.equal(env.PROPR_IDLE_SHUTDOWN, undefined);
  assert.equal(env.DOCKER_HOST, undefined);
});

test("idle shutdown is opt-in: on-failure restart, proxy autostop off, autostart on", () => {
  const plan = basePlan({ idleShutdownAfter: "20m" });
  const config = buildMachineConfig(plan);
  assert.equal((config.restart as JsonObject).policy, "on-failure");
  const [service] = config.services as JsonObject[];
  assert.equal(service.autostop, "off");
  assert.equal(service.autostart, true);
  assert.equal(service.min_machines_running, 0);
  const env = buildAppEnv(plan);
  assert.equal(env.PROPR_IDLE_SHUTDOWN, "on");
  assert.equal(env.PROPR_IDLE_SHUTDOWN_AFTER, "20m");

  const toml = renderFlyToml(plan);
  assert.match(toml, /auto_stop_machines = "off"/);
  assert.match(toml, /auto_start_machines = true/);
  assert.match(toml, /policy = "on-failure"/);
  assert.match(renderFlyToml(basePlan()), /policy = "always"/);
});

test("Connect tunnel adds a cloudflared sidecar that resolves api to loopback", () => {
  const plan = basePlan({ tunnel: { instanceId: "abc123", publicUrl: "https://t-abc123.propr.dev" } });
  const config = buildMachineConfig(plan);
  assert.deepEqual(containers(config).map((c) => c.name), ["redis", "app", "tunnel"]);
  const tunnel = container(config, "tunnel");
  assert.deepEqual(tunnel.cmd, ["tunnel", "--no-autoupdate", "run"]);
  const [hosts] = tunnel.files as JsonObject[];
  assert.equal(hosts.guest_path, "/etc/hosts");
  assert.match(Buffer.from(String(hosts.raw_value), "base64").toString(), /^127\.0\.0\.1 localhost api$/m);
  const env = buildAppEnv(plan);
  assert.equal(env.API_PUBLIC_URL, "https://t-abc123.propr.dev");
  assert.equal(env.FRONTEND_URL, "https://app.propr.dev");
  assert.equal(env.PROPR_INSTANCE_ID, "abc123");
  assert.equal(env.PROPR_UI_TUNNEL_ENABLED, "true");
  assert.match(env.PROPR_TRUSTED_PROXY_PEERS, /^loopback,/);
  assert.equal(JSON.stringify(config).includes("TUNNEL_TOKEN="), false);
});

test("GitHub App key is written from a secret, not embedded", () => {
  const config = buildMachineConfig(basePlan({ githubAppKey: true }));
  const app = container(config, "app");
  assert.deepEqual(app.files, [{ guest_path: FLY_GH_PRIVATE_KEY_PATH, secret_name: FLY_GH_PRIVATE_KEY_SECRET, mode: 0o400 }]);
  assert.equal((app.env as Record<string, string>).GH_PRIVATE_KEY_PATH, FLY_GH_PRIVATE_KEY_PATH);
});

test("legacy Docker mode adds the daemon container and shares worktree paths", () => {
  const config = buildMachineConfig(basePlan({ legacyDocker: true, agentRuntime: "docker", memoryMb: 2048, volumeSizeGb: 20 }));
  assert.deepEqual(containers(config).map((c) => c.name), ["redis", "docker", "app"]);
  const app = container(config, "app");
  const env = app.env as Record<string, string>;
  assert.equal(env.DOCKER_HOST, "tcp://127.0.0.1:2375");
  assert.ok(env.GIT_WORKTREES_BASE_PATH.startsWith("/propr-shared/"));
  assert.deepEqual(app.mounts, [{ name: "propr_shared", path: "/propr-shared" }]);
  assert.deepEqual(container(config, "docker").mounts, app.mounts);
  assert.deepEqual(app.depends_on, [{ name: "redis", condition: "healthy" }, { name: "docker", condition: "healthy" }]);
  assert.deepEqual(config.volumes, [{ name: "propr_shared", temp_dir: { storage_type: "disk", size_mb: 8192 } }]);
});

test("flyctl files: fly.toml points at the machine config and the deployed container", () => {
  const plan = basePlan();
  const toml = renderFlyToml(plan);
  assert.match(toml, /^app = "my-propr"$/m);
  assert.match(toml, /^primary_region = "iad"$/m);
  assert.match(toml, /image = "propr\/app:0\.9\.3"/);
  assert.match(toml, /machine_config = "propr-machine\.json"/);
  assert.match(toml, /container = "app"/);
  assert.match(toml, /destination = "\/usr\/src\/app\/data"/);
  assert.match(toml, /size = "shared-cpu-1x"/);
  assert.match(toml, /memory = "1024mb"/);
  const doc = JSON.parse(renderFlyMachineConfigJson(plan)) as JsonObject;
  assert.deepEqual((doc.containers as JsonObject[]).map((c) => c.name), ["redis", "app"]);
});

test("stack .env selection drops host paths, empty and deploy-managed keys", () => {
  assert.deepEqual(selectEnvFileSecrets({
    SESSION_SECRET: "s",
    ANTHROPIC_API_KEY: "k",
    HOST_CLAUDE_DIR: "/home/me/.claude",
    DB_FILENAME: "./data/propr.sqlite",
    NODE_ENV: "development",
    REDIS_HOST: "127.0.0.1",
    API_PUBLIC_URL: "http://localhost:4000",
    MCP_ENABLED: "",
  }), { SESSION_SECRET: "s", ANTHROPIC_API_KEY: "k" });
});

test("name validation", () => {
  assert.equal(validateFlyAppName("my-propr"), null);
  assert.ok(validateFlyAppName("My_App"));
  assert.ok(validateFlyAppName("-x"));
  assert.equal(validateFlyVolumeName("propr_data"), null);
  assert.ok(validateFlyVolumeName("propr-data"));
});
