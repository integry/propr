import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateRelease } from "../scripts/lib/release-validation.mjs";

const validInput = () => ({
  tag: "v1.2.3",
  expectedVersion: "1.2.3",
  packages: [
    {
      name: "propr",
      version: "1.2.3",
      releaseVersioned: false,
      internalDependencies: { "@propr/core": "^1.2.3" },
    },
    {
      name: "@propr/api",
      version: "1.2.3",
      releaseVersioned: true,
      internalDependencies: { "@propr/core": "^1.2.3", "@propr/shared": "^1.2.3" },
    },
    {
      name: "@propr/cli",
      version: "1.2.3",
      releaseVersioned: true,
      internalDependencies: { "@propr/shared": "^1.2.3" },
    },
    {
      name: "@propr/core",
      version: "1.2.3",
      releaseVersioned: true,
      internalDependencies: { "@propr/shared": "^1.2.3" },
    },
    { name: "@propr/shared", version: "1.2.3", releaseVersioned: true, internalDependencies: {} },
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
    input.packages[2].internalDependencies["@propr/shared"] = "^1.2.2";
    input.launcherManifest.version = "1.2.2";
    input.launcherManifest.images.agent = "propr/agent:latest";
    input.changelog = "# Changelog\n\n## [Unreleased]\n";

    const errors = validateRelease(input);
    assert.equal(errors.length, 7);
    assert.ok(errors.some((error) => error.includes("@propr/api version")));
    assert.ok(errors.some((error) => error.includes("Release tag")));
    assert.ok(errors.some((error) => error.includes("CHANGELOG.md")));
  });

  it("allows ordinary branch validation without a dated changelog section", () => {
    const input = validInput();
    input.tag = "";
    input.expectedVersion = "";
    input.changelog = "# Changelog\n\n## [Unreleased]\n";

    assert.deepEqual(validateRelease(input), []);
  });

  it("requires the current version changelog section in release-candidate mode", () => {
    const input = validInput();
    input.tag = "";
    input.expectedVersion = "";
    input.releaseCandidate = true;
    input.changelog = "# Changelog\n\n## [Unreleased]\n";

    assert.deepEqual(validateRelease(input), [
      "CHANGELOG.md needs a dated ## [1.2.3] release section before release validation",
    ]);
  });

  it("rejects drift in every internal workspace dependency range", () => {
    const input = validInput();
    input.packages[1].internalDependencies["@propr/core"] = "^1.2.2";
    input.packages[3].internalDependencies["@propr/shared"] = "*";

    const errors = validateRelease(input);
    assert.ok(errors.some((error) => error.includes("@propr/api must depend on @propr/core@^1.2.3")));
    assert.ok(errors.some((error) => error.includes("@propr/core must depend on @propr/shared@^1.2.3")));
  });

  it("rejects SemVer build metadata because it cannot be used in Docker tags", () => {
    const input = validInput();
    input.tag = "v1.2.3+build.1";
    input.expectedVersion = "1.2.3+build.1";
    for (const pkg of input.packages) pkg.version = "1.2.3+build.1";
    for (const pkg of input.packages) {
      for (const dependency of Object.keys(pkg.internalDependencies)) {
        pkg.internalDependencies[dependency] = "^1.2.3+build.1";
      }
    }
    input.launcherManifest.version = "1.2.3+build.1";
    for (const name of ["app", "ui", "docs", "agent"]) {
      input.launcherManifest.images[name] = `propr/${name}:1.2.3+build.1`;
    }
    input.changelog = "# Changelog\n\n## [1.2.3+build.1] - 2026-08-02\n";

    assert.ok(validateRelease(input).some((error) => error.includes("build metadata")));
  });

  it("rejects prereleases so npm and image latest tags cannot be advanced accidentally", () => {
    const input = validInput();
    input.tag = "v1.2.3-rc.1";
    input.expectedVersion = "1.2.3-rc.1";
    for (const pkg of input.packages) pkg.version = "1.2.3-rc.1";
    for (const pkg of input.packages) {
      for (const dependency of Object.keys(pkg.internalDependencies)) {
        pkg.internalDependencies[dependency] = "^1.2.3-rc.1";
      }
    }
    input.launcherManifest.version = "1.2.3-rc.1";
    for (const name of ["app", "ui", "docs", "agent"]) {
      input.launcherManifest.images[name] = `propr/${name}:1.2.3-rc.1`;
    }
    input.changelog = "# Changelog\n\n## [1.2.3-rc.1] - 2026-08-02\n";

    assert.ok(validateRelease(input).some((error) => error.includes("prerelease identifiers")));
  });

  it("rejects a launcher image whose repository does not match its role", () => {
    const input = validInput();
    input.launcherManifest.images.app = "propr/agent:1.2.3";

    assert.ok(validateRelease(input).some((error) => error.includes("app image repository")));
  });

  it("rejects a role-matching image name from an untrusted registry or namespace", () => {
    const input = validInput();
    input.launcherManifest.images.app = "attacker.example/app:1.2.3";

    assert.ok(validateRelease(input).some((error) => error.includes("propr/app image repository")));
  });

  for (const malformed of [
    "1.2.3-alpha..1",
    "1.2.3-alpha.",
    "1.2.3-01",
    "01.2.3",
  ]) {
    it(`rejects malformed SemVer ${malformed}`, () => {
      const input = validInput();
      input.packages[0].version = malformed;

      assert.ok(validateRelease(input).some((error) => error.includes("not valid release semver")));
    });
  }
});
