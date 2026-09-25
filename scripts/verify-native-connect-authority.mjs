#!/usr/bin/env node
import { join, resolve } from "node:path";
import { runNodeTestProof } from "./lib/node-test-proof.mjs";

if (process.platform !== "darwin") {
  process.stderr.write("Native Connect authority verification requires macOS.\n");
  process.exit(1);
}

// The authority tests skip off Darwin, so a skipped test fails this proof.
const root = resolve(import.meta.dirname, "..");
const proof = runNodeTestProof({
  label: "Native Darwin authority proof",
  root,
  files: [join(root, "test", "nativeConnectAuthority.test.ts")],
  nodeArgs: ["--import", "tsx"],
  timeoutMs: 30_000,
  maxBuffer: 2 * 1024 * 1024,
});
if (!proof.ok) process.exitCode = 1;
