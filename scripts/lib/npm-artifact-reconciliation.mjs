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

function readTarOctal(block, start, length, errorMessage) {
  const value = block.subarray(start, start + length).toString("ascii").match(/^[ \0]*([0-7]+)[ \0]*$/)?.[1];
  if (value === undefined) throw new Error(errorMessage);
  const number = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(errorMessage);
  return number;
}

function readTarSize(block) {
  return readTarOctal(block, 124, 12, "npm artifact contains an invalid tar entry size");
}

function validateTarHeaderChecksum(header) {
  const expected = readTarOctal(header, 148, 8, "npm artifact contains an invalid tar header checksum");
  let actual = 0;
  for (let index = 0; index < TAR_BLOCK_BYTES; index += 1) {
    actual += index >= 148 && index < 156 ? 0x20 : header[index];
  }
  if (actual !== expected) throw new Error("npm artifact contains an invalid tar header checksum");
}

function isZeroBlock(block) {
  return block.every((byte) => byte === 0);
}

function readPackageManifest(tarBuffer) {
  if (tarBuffer.length % TAR_BLOCK_BYTES !== 0) {
    throw new Error("npm artifact has an invalid tar block boundary");
  }

  let offset = 0;
  let manifest;
  let terminated = false;
  while (offset < tarBuffer.length) {
    const header = tarBuffer.subarray(offset, offset + TAR_BLOCK_BYTES);
    if (isZeroBlock(header)) {
      const secondTerminator = tarBuffer.subarray(offset + TAR_BLOCK_BYTES, offset + 2 * TAR_BLOCK_BYTES);
      if (secondTerminator.length !== TAR_BLOCK_BYTES || !isZeroBlock(secondTerminator)) {
        throw new Error("npm artifact has an invalid tar terminator");
      }
      if (!tarBuffer.subarray(offset + 2 * TAR_BLOCK_BYTES).every((byte) => byte === 0)) {
        throw new Error("npm artifact contains data after the tar terminator");
      }
      terminated = true;
      break;
    }

    validateTarHeaderChecksum(header);
    const name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const entryPath = prefix ? `${prefix}/${name}` : name;
    const size = readTarSize(header);
    const contentStart = offset + TAR_BLOCK_BYTES;
    const contentEnd = contentStart + size;
    const nextOffset = contentStart + Math.ceil(size / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
    if (contentEnd > tarBuffer.length || nextOffset > tarBuffer.length) {
      throw new Error("npm artifact contains a truncated tar entry");
    }
    if (!tarBuffer.subarray(contentEnd, nextOffset).every((byte) => byte === 0)) {
      throw new Error("npm artifact contains invalid tar entry padding");
    }

    if (entryPath === PACKAGE_MANIFEST_PATH) {
      if (header[156] !== 0 && header[156] !== 0x30) {
        throw new Error(`npm artifact ${PACKAGE_MANIFEST_PATH} must be a regular file`);
      }
      if (manifest !== undefined) {
        throw new Error(`npm artifact contains duplicate ${PACKAGE_MANIFEST_PATH} entries`);
      }
      try {
        manifest = JSON.parse(tarBuffer.subarray(contentStart, contentEnd).toString("utf8"));
      } catch {
        throw new Error("npm artifact package.json is invalid JSON");
      }
    }
    offset = nextOffset;
  }

  if (!terminated) throw new Error("npm artifact is missing a valid tar terminator");
  if (manifest === undefined) throw new Error(`npm artifact is missing ${PACKAGE_MANIFEST_PATH}`);
  return manifest;
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
