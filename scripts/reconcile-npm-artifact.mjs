#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import {
  classifyPublishedArtifact,
  inspectNpmArtifact,
  isNpmNotFoundError,
  validateNpmArtifactIdentity,
} from "./lib/npm-artifact-reconciliation.mjs";

const { values } = parseArgs({
  options: {
    artifact: { type: "string" },
    "expected-name": { type: "string" },
    "expected-version": { type: "string" },
    publish: { type: "boolean", default: false },
  },
  strict: true,
});

if (!values.artifact || !values["expected-name"] || !values["expected-version"]) {
  console.error("Usage: reconcile-npm-artifact.mjs --artifact <tgz> --expected-name <name> --expected-version <version> [--publish]");
  process.exit(2);
}

function lookupPublishedIntegrity(packageSpec) {
  try {
    const output = execFileSync(
      "npm",
      ["view", packageSpec, "dist.integrity", "--json"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
    const integrity = JSON.parse(output);
    if (typeof integrity !== "string" || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(integrity)) {
      throw new Error(`npm returned invalid integrity metadata for ${packageSpec}`);
    }
    return integrity;
  } catch (error) {
    if (error instanceof SyntaxError || !(error && typeof error === "object" && "stderr" in error)) throw error;
    const stderr = String(error.stderr ?? "");
    if (isNpmNotFoundError(stderr)) return null;
    if (stderr) process.stderr.write(stderr);
    throw new Error(`Unable to determine whether ${packageSpec} is published`);
  }
}

function main() {
  const artifact = inspectNpmArtifact(values.artifact);
  validateNpmArtifactIdentity(artifact, {
    name: values["expected-name"],
    version: values["expected-version"],
  });
  const packageSpec = `${artifact.name}@${artifact.version}`;
  let classification;
  try {
    classification = classifyPublishedArtifact(
      artifact.integrity,
      lookupPublishedIntegrity(packageSpec),
    );
  } catch (error) {
    throw new Error(`${packageSpec}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (classification === "matching") {
    console.log(`${packageSpec} is already published with the matching artifact`);
    return;
  }
  if (!values.publish) {
    console.log(`${packageSpec} is unpublished and safe to publish after immutable images complete`);
    return;
  }

  console.log(`Publishing verified artifact ${packageSpec}`);
  execFileSync("npm", ["publish", values.artifact, "--access", "public"], { stdio: "inherit" });
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
