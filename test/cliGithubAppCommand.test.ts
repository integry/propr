import { describe, test } from "node:test";
import assert from "node:assert";
import fs from "fs";
import { mkdtemp, readFile, rm } from "fs/promises";
import os from "os";
import path from "path";
import {
  generateGithubAppManifest,
  generateWebhookSecret,
  MANIFEST_FILENAME,
  ENV_FILENAME,
  PROPR_APP_PERMISSIONS,
  PROPR_WEBHOOK_EVENTS,
} from "../packages/cli/src/commands/githubAppCommands.js";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "propr-cli-ghapp-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("generateGithubAppManifest", () => {
  test("writes manifest and env files with expected contents", async () => {
    await withTempDir(async (dir) => {
      const result = await generateGithubAppManifest({
        root: dir,
        publicUrl: "https://propr.example.com",
      });

      const manifestPath = path.join(dir, MANIFEST_FILENAME);
      const envPath = path.join(dir, ENV_FILENAME);

      assert.strictEqual(result.manifestPath, manifestPath);
      assert.strictEqual(result.envPath, envPath);
      assert.ok(fs.existsSync(manifestPath));
      assert.ok(fs.existsSync(envPath));

      const manifest = JSON.parse(await readFile(manifestPath, "utf-8"));

      // Webhook URL defaults to <public-url>/webhook
      assert.strictEqual(
        manifest.hook_attributes.url,
        "https://propr.example.com/webhook"
      );
      assert.strictEqual(manifest.hook_attributes.active, true);

      // Permissions
      assert.deepStrictEqual(
        manifest.default_permissions,
        PROPR_APP_PERMISSIONS
      );
      assert.strictEqual(manifest.default_permissions.contents, "write");
      assert.strictEqual(manifest.default_permissions.actions, "read");

      // Events
      assert.deepStrictEqual(manifest.default_events, PROPR_WEBHOOK_EVENTS);

      // Env snippet contents
      const env = await readFile(envPath, "utf-8");
      assert.match(env, /GH_AUTH_MODE=app/);
      assert.match(env, /GITHUB_EVENT_INTAKE_MODE=direct_webhook/);

      // Same webhook secret used in the manifest and the env file
      assert.strictEqual(
        manifest.hook_attributes.secret,
        result.webhookSecret
      );
      assert.ok(env.includes(`GH_WEBHOOK_SECRET=${result.webhookSecret}`));

      // A create URL is surfaced
      assert.ok(result.createUrl.startsWith("https://github.com/"));
    });
  });

  test("generates a cryptographically strong secret when none supplied", async () => {
    await withTempDir(async (dir) => {
      const result = await generateGithubAppManifest({
        root: dir,
        publicUrl: "https://propr.example.com",
      });
      // 32 random bytes -> 64 hex chars
      assert.match(result.webhookSecret, /^[0-9a-f]{64}$/);
    });
  });

  test("uses a supplied webhook secret verbatim", async () => {
    await withTempDir(async (dir) => {
      const result = await generateGithubAppManifest({
        root: dir,
        publicUrl: "https://propr.example.com",
        webhookSecret: "my-custom-secret",
      });
      assert.strictEqual(result.webhookSecret, "my-custom-secret");
      assert.strictEqual(result.manifest.hook_attributes.secret, "my-custom-secret");
    });
  });

  test("honors a custom webhook URL override", async () => {
    await withTempDir(async (dir) => {
      const result = await generateGithubAppManifest({
        root: dir,
        publicUrl: "https://propr.example.com",
        webhookUrl: "https://hooks.example.com/ingest",
      });
      assert.strictEqual(result.webhookUrl, "https://hooks.example.com/ingest");
      assert.strictEqual(
        result.manifest.hook_attributes.url,
        "https://hooks.example.com/ingest"
      );
    });
  });

  test("normalizes trailing slashes in the public URL", async () => {
    await withTempDir(async (dir) => {
      const result = await generateGithubAppManifest({
        root: dir,
        publicUrl: "https://propr.example.com/",
      });
      assert.strictEqual(result.webhookUrl, "https://propr.example.com/webhook");
    });
  });

  test("refuses to overwrite existing files without force", async () => {
    await withTempDir(async (dir) => {
      await generateGithubAppManifest({
        root: dir,
        publicUrl: "https://propr.example.com",
      });

      await assert.rejects(
        generateGithubAppManifest({
          root: dir,
          publicUrl: "https://propr.example.com",
        }),
        /Refusing to overwrite/
      );
    });
  });

  test("overwrites existing files when force is set", async () => {
    await withTempDir(async (dir) => {
      const first = await generateGithubAppManifest({
        root: dir,
        publicUrl: "https://propr.example.com",
      });

      const second = await generateGithubAppManifest({
        root: dir,
        publicUrl: "https://new.example.com",
        force: true,
      });

      assert.notStrictEqual(first.webhookSecret, second.webhookSecret);
      const manifest = JSON.parse(
        await readFile(path.join(dir, MANIFEST_FILENAME), "utf-8")
      );
      assert.strictEqual(
        manifest.hook_attributes.url,
        "https://new.example.com/webhook"
      );
    });
  });

  test("rejects a missing or invalid public URL", async () => {
    await withTempDir(async (dir) => {
      await assert.rejects(
        generateGithubAppManifest({ root: dir, publicUrl: "" }),
        /public base URL is required/
      );
      await assert.rejects(
        generateGithubAppManifest({ root: dir, publicUrl: "not-a-url" }),
        /Invalid --public-url/
      );
      await assert.rejects(
        generateGithubAppManifest({ root: dir, publicUrl: "ftp://example.com" }),
        /must use http/
      );
    });
  });
});

describe("generateWebhookSecret", () => {
  test("returns 64 hex chars and is non-repeating", () => {
    const a = generateWebhookSecret();
    const b = generateWebhookSecret();
    assert.match(a, /^[0-9a-f]{64}$/);
    assert.notStrictEqual(a, b);
  });
});
