import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { gzipSync } from "node:zlib";
import {
  classifyPublishedArtifact,
  inspectNpmArtifact,
  isNpmNotFoundError,
  validateNpmArtifactIdentity,
} from "../scripts/lib/npm-artifact-reconciliation.mjs";

const fixtures = [];

function tarEntry(name, content) {
  const body = Buffer.from(content);
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write("0000644\0", 100, 8, "ascii");
  header.write("0000000\0", 108, 8, "ascii");
  header.write("0000000\0", 116, 8, "ascii");
  header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
  header.write("00000000000\0", 136, 12, "ascii");
  header.fill(0x20, 148, 156);
  header.write("0", 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  const checksum = [...header].reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  const padding = Buffer.alloc(Math.ceil(body.length / 512) * 512 - body.length);
  return Buffer.concat([header, body, padding]);
}

function createArtifact(manifest = { name: "propr-cli", version: "1.2.3" }) {
  const root = mkdtempSync(join(tmpdir(), "propr-npm-artifact-"));
  fixtures.push(root);
  const compressed = gzipSync(Buffer.concat([
    tarEntry("package/package.json", JSON.stringify(manifest)),
    Buffer.alloc(1024),
  ]));
  const artifactPath = join(root, "package.tgz");
  writeFileSync(artifactPath, compressed);
  return { artifactPath, compressed };
}

afterEach(() => {
  while (fixtures.length > 0) rmSync(fixtures.pop(), { recursive: true, force: true });
});

describe("npm release artifact reconciliation", () => {
  test("reads the package identity and exact tarball integrity", () => {
    const { artifactPath, compressed } = createArtifact();
    assert.deepEqual(inspectNpmArtifact(artifactPath), {
      name: "propr-cli",
      version: "1.2.3",
      integrity: `sha512-${createHash("sha512").update(compressed).digest("base64")}`,
    });
  });

  test("fails closed when the packed public name or version drifts", () => {
    const artifact = inspectNpmArtifact(createArtifact().artifactPath);
    assert.throws(
      () => validateNpmArtifactIdentity(artifact, { name: "@propr/cli", version: "1.2.3" }),
      /name propr-cli does not match expected package/,
    );
    assert.throws(
      () => validateNpmArtifactIdentity(artifact, { name: "propr-cli", version: "1.2.4" }),
      /version 1.2.3 does not match expected version/,
    );
  });

  test("accepts only a missing version or an exact published integrity match", () => {
    assert.equal(classifyPublishedArtifact("sha512-local", null), "missing");
    assert.equal(classifyPublishedArtifact("sha512-same", "sha512-same"), "matching");
    assert.throws(
      () => classifyPublishedArtifact("sha512-local", "sha512-other"),
      /already exists with different package contents/,
    );
  });

  test("does not confuse authorization failures with registry misses", () => {
    assert.equal(isNpmNotFoundError("npm error code E404\nnpm error 404 Not Found"), true);
    assert.equal(isNpmNotFoundError("npm error code E403\nforbidden"), false);
    assert.equal(isNpmNotFoundError("unauthorized E404"), false);
  });

  test("rejects malformed, oversized-identity, and non-release manifests", () => {
    assert.throws(() => inspectNpmArtifact(createArtifact({ name: "Bad Name", version: "1.2.3" }).artifactPath), /invalid package name/);
    assert.throws(() => inspectNpmArtifact(createArtifact({ name: "propr-cli", version: "1.2.3-beta.1" }).artifactPath), /invalid release version/);
  });
});
