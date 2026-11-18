import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { releaseNotesPath, validateRelease, validateReleaseNotes } from "../scripts/lib/release-validation.mjs";

const validReleaseNotes = (version = "1.2.3") => [
  "## Highlights",
  "",
  `ProPR ${version} does useful things. Full details: [What's new in ${version}](https://propr.dev/whats-new/${version}/) and the [changelog](https://github.com/integry/propr/blob/v${version}/CHANGELOG.md).`,
  "",
  "**Pull requests**",
  "- One status per pull request.",
  "",
  "## Upgrade notes",
  "",
  "None.",
  "",
].join("\n");

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
  releaseNotes: validReleaseNotes(),
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

  it("allows ordinary branch validation without release notes", () => {
    const input = validInput();
    input.tag = "";
    input.expectedVersion = "";
    input.releaseNotes = undefined;

    assert.deepEqual(validateRelease(input), []);
  });

  for (const mode of ["tag", "release-candidate"]) {
    it(`requires the version's release notes file in ${mode} mode`, () => {
      const input = validInput();
      if (mode === "release-candidate") {
        input.tag = "";
        input.expectedVersion = "";
        input.releaseCandidate = true;
      }
      input.releaseNotes = undefined;

      assert.deepEqual(validateRelease(input), [
        "release-notes/v1.2.3.md is missing; write the release summary before release validation",
      ]);
    });
  }

  it("names the release notes file after the version", () => {
    assert.equal(releaseNotesPath("0.9.2"), "release-notes/v0.9.2.md");
  });

  it("rejects empty release notes", () => {
    for (const notes of ["", "  \n\n\t\n"]) {
      assert.deepEqual(validateReleaseNotes("1.2.3", notes), ["release-notes/v1.2.3.md is empty"]);
    }
  });

  for (const section of ["Highlights", "Upgrade notes"]) {
    it(`rejects release notes without ## ${section}`, () => {
      const notes = validReleaseNotes().replace(`## ${section}\n`, `### ${section}\n`);

      assert.deepEqual(validateReleaseNotes("1.2.3", notes), [
        `release-notes/v1.2.3.md needs a ## ${section} section`,
      ]);
    });

    it(`rejects an empty ## ${section} section`, () => {
      const notes = section === "Highlights"
        ? `## Highlights\n\n## Upgrade notes\n\nNone.\n${validReleaseNotes().split("\n")[2]}\n`
        : `${validReleaseNotes().split("## Upgrade notes")[0]}## Upgrade notes\n\n   \n`;

      assert.ok(validateReleaseNotes("1.2.3", notes).some((error) =>
        error.includes(`empty ## ${section} section`)
      ));
    });
  }

  it("rejects release notes with the sections in the wrong order", () => {
    const [highlights, upgrade] = validReleaseNotes().split("## Upgrade notes");
    const notes = `## Upgrade notes${upgrade}\n${highlights}`;

    assert.deepEqual(validateReleaseNotes("1.2.3", notes), [
      "release-notes/v1.2.3.md must put ## Upgrade notes after ## Highlights",
    ]);
  });

  for (const placeholder of [
    "TODO: summarize",
    "TBD",
    "FIXME",
    "XXX",
    "<!-- write the highlights here -->",
    "<one sentence about the release>",
    "{{ highlights }}",
    "Lorem ipsum dolor sit amet",
  ]) {
    it(`rejects the release notes placeholder ${JSON.stringify(placeholder)}`, () => {
      const notes = validReleaseNotes().replace("None.", placeholder);

      const errors = validateReleaseNotes("1.2.3", notes);
      assert.equal(errors.length, 1);
      assert.match(errors[0], /^release-notes\/v1\.2\.3\.md still contains a placeholder: /);
    });
  }

  it("allows plain URL autolinks in release notes", () => {
    const notes = validReleaseNotes().replace("None.", "See <https://docs.propr.dev/>.");

    assert.deepEqual(validateReleaseNotes("1.2.3", notes), []);
  });

  it("requires links to the changelog at the tag and to the what's-new page", () => {
    const notes = validReleaseNotes().replace(/\[What's new[^\n]*/, "Read the changelog.");

    assert.deepEqual(validateReleaseNotes("1.2.3", notes), [
      "release-notes/v1.2.3.md must link to https://github.com/integry/propr/blob/v1.2.3/CHANGELOG.md",
      "release-notes/v1.2.3.md must link to https://propr.dev/whats-new/1.2.3/",
    ]);
  });

  it("rejects release notes written for another version", () => {
    assert.equal(validateReleaseNotes("1.2.4", validReleaseNotes("1.2.3")).length, 2);
  });

  it("accepts the checked-in release notes for the current version", () => {
    const { version } = JSON.parse(readFileSync("package.json", "utf8"));
    const notes = readFileSync(releaseNotesPath(version), "utf8");

    assert.deepEqual(validateReleaseNotes(version, notes), []);
    assert.ok(notes.split("\n").length <= 60, "the release summary stays short");
  });

  it("rejects drift in every internal workspace dependency range", () => {
    const input = validInput();
    input.packages[1].internalDependencies["@propr/core"] = "^1.2.2";
    input.packages[3].internalDependencies["@propr/shared"] = "*";

    const errors = validateRelease(input);
    assert.ok(errors.some((error) => error.includes("@propr/api must depend on @propr/core@^1.2.3")));
    assert.ok(errors.some((error) => error.includes("@propr/core must depend on @propr/shared@^1.2.3")));
  });

  it("rejects internal dependencies missing from workspace discovery", () => {
    const input = validInput();
    input.packages[1].internalDependencies["@propr/missing"] = "^1.2.3";

    assert.ok(validateRelease(input).some((error) =>
      error.includes("@propr/api depends on undiscovered internal package @propr/missing")
    ));
  });

  it("allows explicitly external @propr dependencies", () => {
    const input = validInput();
    input.packages[1].internalDependencies["@propr/external-sdk"] = "^9.0.0";
    input.externalInternalDependencies = ["@propr/external-sdk"];

    assert.deepEqual(validateRelease(input), []);
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
