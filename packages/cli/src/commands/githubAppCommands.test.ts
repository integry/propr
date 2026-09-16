/**
 * Tests for the `propr github-app manifest` generator. Run with:
 * `npx tsx --test src/commands/githubAppCommands.test.ts` (from packages/cli).
 *
 * Locks in the acceptance criteria from the issue: the right files are written,
 * the manifest carries the expected webhook URL / permissions / events, the
 * `.env` snippet selects direct webhook mode with the same secret, and a
 * repeated run refuses to overwrite unless `--force` is passed.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  generateGithubAppManifest,
  generateWebhookSecret,
  redactSecret,
  PROPR_APP_PERMISSIONS,
  PROPR_WEBHOOK_EVENTS,
  MANIFEST_FILENAME,
  ENV_FILENAME,
} from "./githubAppCommands.js";

async function withTempDir(
  fn: (dir: string) => Promise<void>
): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "propr-ghapp-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("writes the manifest and env files into --root", async () => {
  await withTempDir(async (dir) => {
    const result = await generateGithubAppManifest({
      root: dir,
      publicUrl: "https://propr.example.com",
    });

    assert.equal(result.manifestPath, path.join(dir, MANIFEST_FILENAME));
    assert.equal(result.envPath, path.join(dir, ENV_FILENAME));

    // Both files are actually on disk and parseable.
    const manifestRaw = await readFile(result.manifestPath, "utf-8");
    const manifest = JSON.parse(manifestRaw);
    assert.equal(manifest.name, "ProPR");

    const env = await readFile(result.envPath, "utf-8");
    assert.match(env, /GH_AUTH_MODE=app/);
  });
});

test("manifest carries the expected webhook URL, permissions, and events", async () => {
  await withTempDir(async (dir) => {
    const { manifest, webhookUrl } = await generateGithubAppManifest({
      root: dir,
      publicUrl: "https://propr.example.com/",
    });

    // Trailing slash on the public URL must not double up in the webhook URL.
    assert.equal(webhookUrl, "https://propr.example.com/webhook");
    assert.equal(manifest.hook_attributes.url, webhookUrl);
    assert.equal(manifest.hook_attributes.active, true);
    assert.equal(manifest.public, false);
    assert.equal(manifest.url, "https://propr.example.com");

    assert.deepEqual(manifest.default_permissions, {
      contents: "write",
      issues: "write",
      pull_requests: "write",
      metadata: "read",
      actions: "read",
      checks: "read",
      statuses: "read",
    });

    // Every event ProPR's core webhook handler understands must be subscribed.
    for (const event of [
      "issues",
      "issue_comment",
      "pull_request_review_comment",
      "pull_request",
      "check_run",
      "push",
      "status",
    ]) {
      assert.ok(
        manifest.default_events.includes(event),
        `manifest should subscribe to "${event}"`
      );
    }
  });
});

test("env snippet selects direct webhook mode with the manifest's secret", async () => {
  await withTempDir(async (dir) => {
    const result = await generateGithubAppManifest({
      root: dir,
      publicUrl: "https://propr.example.com",
    });

    const env = await readFile(result.envPath, "utf-8");
    assert.match(env, /^GH_AUTH_MODE=app$/m);
    assert.match(env, /^GITHUB_EVENT_INTAKE_MODE=direct_webhook$/m);
    assert.match(
      env,
      new RegExp(`^GH_WEBHOOK_SECRET=${result.webhookSecret}$`, "m")
    );

    // The secret in the env file and the manifest must be identical.
    assert.equal(result.manifest.hook_attributes.secret, result.webhookSecret);
  });
});

test("generates a cryptographically strong secret when none is supplied", async () => {
  await withTempDir(async (dir) => {
    const { webhookSecret } = await generateGithubAppManifest({
      root: dir,
      publicUrl: "https://propr.example.com",
    });
    // 32 random bytes -> 64 hex chars.
    assert.match(webhookSecret, /^[0-9a-f]{64}$/);
  });
});

test("honors a supplied webhook secret", async () => {
  await withTempDir(async (dir) => {
    const { webhookSecret, manifest } = await generateGithubAppManifest({
      root: dir,
      publicUrl: "https://propr.example.com",
      webhookSecret: "my-explicit-secret",
    });
    assert.equal(webhookSecret, "my-explicit-secret");
    assert.equal(manifest.hook_attributes.secret, "my-explicit-secret");
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

test("refuses even when only one of the two output files exists", async () => {
  await withTempDir(async (dir) => {
    // Pre-create just the env file; the manifest does not exist yet. The
    // preflight must still refuse so we never write a half-pair.
    await writeFile(path.join(dir, ENV_FILENAME), "stale\n", "utf-8");

    await assert.rejects(
      generateGithubAppManifest({
        root: dir,
        publicUrl: "https://propr.example.com",
      }),
      /Refusing to overwrite/
    );

    // The manifest must not have been written by the refused run.
    await assert.rejects(readFile(path.join(dir, MANIFEST_FILENAME), "utf-8"));
  });
});

test("force overwrites existing files", async () => {
  await withTempDir(async (dir) => {
    const first = await generateGithubAppManifest({
      root: dir,
      publicUrl: "https://propr.example.com",
    });
    const second = await generateGithubAppManifest({
      root: dir,
      publicUrl: "https://propr.example.com",
      force: true,
    });
    // A fresh secret each run confirms the second write actually replaced the
    // first rather than being skipped.
    assert.notEqual(first.webhookSecret, second.webhookSecret);
  });
});

test("rejects a non-http(s) public URL", async () => {
  await withTempDir(async (dir) => {
    await assert.rejects(
      generateGithubAppManifest({ root: dir, publicUrl: "ftp://nope.example" }),
      /must use http:\/\/ or https:\/\//
    );
    await assert.rejects(
      generateGithubAppManifest({ root: dir, publicUrl: "not a url" }),
      /is not a valid URL/
    );
  });
});

test("requires a public URL", async () => {
  await withTempDir(async (dir) => {
    await assert.rejects(
      generateGithubAppManifest({ root: dir, publicUrl: "  " }),
      /public base URL is required/
    );
  });
});

test("a custom webhook URL overrides the default", async () => {
  await withTempDir(async (dir) => {
    const { webhookUrl, manifest } = await generateGithubAppManifest({
      root: dir,
      publicUrl: "https://propr.example.com",
      webhookUrl: "https://hooks.example.com/ingest",
    });
    assert.equal(webhookUrl, "https://hooks.example.com/ingest");
    assert.equal(manifest.hook_attributes.url, "https://hooks.example.com/ingest");
  });
});

test("org scoping points the create URL at the org App page", async () => {
  await withTempDir(async (dir) => {
    const personal = await generateGithubAppManifest({
      root: dir,
      publicUrl: "https://propr.example.com",
    });
    assert.equal(personal.createUrl, "https://github.com/settings/apps/new");

    const org = await generateGithubAppManifest({
      root: dir,
      publicUrl: "https://propr.example.com",
      org: "acme",
      force: true,
    });
    assert.equal(
      org.createUrl,
      "https://github.com/organizations/acme/settings/apps/new"
    );
  });
});

test("redactSecret hides the secret in both places without mutating the input", () => {
  const secret = generateWebhookSecret();
  const result = {
    directory: "/tmp/x",
    manifestPath: "/tmp/x/m.json",
    envPath: "/tmp/x/e.env",
    publicUrl: "https://propr.example.com",
    webhookUrl: "https://propr.example.com/webhook",
    webhookSecret: secret,
    createUrl: "https://github.com/settings/apps/new",
    manifest: {
      name: "ProPR",
      url: "https://propr.example.com",
      hook_attributes: {
        url: "https://propr.example.com/webhook",
        active: true,
        secret,
      },
      redirect_url: "https://propr.example.com/",
      public: false,
      default_permissions: { ...PROPR_APP_PERMISSIONS },
      default_events: [...PROPR_WEBHOOK_EVENTS],
    },
  };

  const redacted = redactSecret(result);
  assert.notEqual(redacted.webhookSecret, secret);
  assert.notEqual(redacted.manifest.hook_attributes.secret, secret);
  // Original is untouched.
  assert.equal(result.webhookSecret, secret);
  assert.equal(result.manifest.hook_attributes.secret, secret);
});

test("CLI events list matches the documented core webhook events", () => {
  // Guards against drift: PROPR_WEBHOOK_EVENTS in the CLI must mirror
  // SUPPORTED_WEBHOOK_EVENTS in @propr/core (duplicated intentionally to avoid
  // a core dependency).
  assert.deepEqual(PROPR_WEBHOOK_EVENTS, [
    "issues",
    "issue_comment",
    "pull_request_review_comment",
    "pull_request",
    "check_run",
    "push",
    "status",
  ]);
});
