import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

const MAX_TARBALL_BYTES = 25 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 100 * 1024 * 1024;
const TAR_BLOCK_BYTES = 512;
const PACKAGE_MANIFEST_PATH = "package/package.json";

function readTarString(block, start, length) {
  return block.subarray(start, start + length).toString("utf8").replace(/\0.*$/s, "").trim();
}

function readTarSize(block) {
  const value = readTarString(block, 124, 12);
  if (!/^[0-7]+$/.test(value)) throw new Error("npm artifact contains an invalid tar entry size");
  const size = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(size) || size < 0) throw new Error("npm artifact tar entry is too large");
  return size;
}

function readPackageManifest(tarBuffer) {
  let offset = 0;
  while (offset + TAR_BLOCK_BYTES <= tarBuffer.length) {
    const header = tarBuffer.subarray(offset, offset + TAR_BLOCK_BYTES);
    if (header.every((byte) => byte === 0)) break;
    const name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const entryPath = prefix ? `${prefix}/${name}` : name;
    const size = readTarSize(header);
    const contentStart = offset + TAR_BLOCK_BYTES;
    const contentEnd = contentStart + size;
    if (contentEnd > tarBuffer.length) throw new Error("npm artifact contains a truncated tar entry");
    if (entryPath === PACKAGE_MANIFEST_PATH) {
      try {
        return JSON.parse(tarBuffer.subarray(contentStart, contentEnd).toString("utf8"));
      } catch {
        throw new Error("npm artifact package.json is invalid JSON");
      }
    }
    offset = contentStart + Math.ceil(size / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
  }
  throw new Error(`npm artifact is missing ${PACKAGE_MANIFEST_PATH}`);
}

function isValidPackageName(name) {
  return typeof name === "string"
    && name.length > 0
    && name.length <= 214
    && /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/.test(name);
}

function isCanonicalReleaseVersion(version) {
  return typeof version === "string"
    && /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(version);
}

export function inspectNpmArtifact(artifactPath) {
  const compressed = readFileSync(artifactPath);
  if (compressed.length === 0 || compressed.length > MAX_TARBALL_BYTES) {
    throw new Error(`npm artifact must be between 1 and ${MAX_TARBALL_BYTES} bytes`);
  }
  let unpacked;
  try {
    unpacked = gunzipSync(compressed, { maxOutputLength: MAX_UNPACKED_BYTES });
  } catch {
    throw new Error("npm artifact is not a valid bounded gzip tarball");
  }
  const manifest = readPackageManifest(unpacked);
  if (!isValidPackageName(manifest.name)) throw new Error("npm artifact has an invalid package name");
  if (!isCanonicalReleaseVersion(manifest.version)) throw new Error("npm artifact has an invalid release version");
  return {
    name: manifest.name,
    version: manifest.version,
    integrity: `sha512-${createHash("sha512").update(compressed).digest("base64")}`,
  };
}

export function validateNpmArtifactIdentity(artifact, expected) {
  if (artifact.name !== expected.name) {
    throw new Error(`npm artifact name ${artifact.name} does not match expected package ${expected.name}`);
  }
  if (artifact.version !== expected.version) {
    throw new Error(`npm artifact version ${artifact.version} does not match expected version ${expected.version}`);
  }
}

export function classifyPublishedArtifact(localIntegrity, publishedIntegrity) {
  if (publishedIntegrity === null) return "missing";
  if (publishedIntegrity === localIntegrity) return "matching";
  throw new Error("npm package version already exists with different package contents");
}

export function isNpmNotFoundError(stderr) {
  return /(?:\bE404\b|404 Not Found)/i.test(stderr)
    && !/(?:\bE401\b|\bE403\b|unauthorized|forbidden)/i.test(stderr);
}
