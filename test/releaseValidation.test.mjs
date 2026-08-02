import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateRelease } from "../scripts/lib/release-validation.mjs";

const validInput = () => ({
  tag: "v1.2.3",
  expectedVersion: "1.2.3",
  packages: [
    { name: "propr", version: "1.2.3", releaseVersioned: false },
    { name: "@propr/api", version: "1.2.3", releaseVersioned: true },
    {
      name: "@propr/cli",
      version: "1.2.3",
      releaseVersioned: true,
      sharedDependency: "^1.2.3",
    },
    { name: "@propr/core", version: "1.2.3", releaseVersioned: true },
    { name: "@propr/shared", version: "1.2.3", releaseVersioned: true },
  ],
  launcherManifest: {
    version: "1.2.3",
    images: Object.fromEntries(
      ["app", "ui", "docs", "agent"].map((name) => [name, `propr/${name}:1.2.3`]),
    ),
  },
  changelog: "# Changelog\n\n## [1.2.3] - 2026-08-02\n",
});

describe("release validation", () => {
  it("accepts synchronized release metadata", () => {
    assert.deepEqual(validateRelease(validInput()), []);
  });

  it("reports every release surface that drifted", () => {
    const input = validInput();
    input.tag = "v1.2.4";
    input.expectedVersion = "1.2.5";
    input.packages[1].version = "1.2.2";
    input.packages[2].sharedDependency = "^1.2.2";
    input.launcherManifest.version = "1.2.2";
    input.launcherManifest.images.agent = "propr/agent:latest";
    input.changelog = "# Changelog\n\n## [Unreleased]\n";

    const errors = validateRelease(input);
    assert.equal(errors.length, 7);
    assert.ok(errors.some((error) => error.includes("@propr/api version")));
    assert.ok(errors.some((error) => error.includes("Release tag")));
    assert.ok(errors.some((error) => error.includes("CHANGELOG.md")));
  });

  it("allows unreleased branch validation without a dated changelog section", () => {
    const input = validInput();
    input.tag = "";
    input.expectedVersion = "";
    input.changelog = "# Changelog\n\n## [Unreleased]\n";

    assert.deepEqual(validateRelease(input), []);
  });
});
