import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRuntimePackageVerificationResult } from "../api/agentRuntime.js";
import {
  filterRemovedRuntimePackages,
  printRuntimePackageVerification,
  runtimePackageVerificationExitCode,
} from "./runtimeCommands.js";

test("runtime package removal matches pinned specs and package base names", () => {
  assert.deepEqual(
    filterRemovedRuntimePackages(
      ["chromium=1.2+BuildA", "ffmpeg", "libgtk-3-0:amd64=3.24.38-2~Deb12u3"],
      ["Chromium", "libgtk-3-0"]
    ),
    ["ffmpeg"]
  );
});

function verificationResult(healthy: boolean): AgentRuntimePackageVerificationResult {
  return {
    status: healthy ? "healthy" : "unhealthy",
    healthy,
    disabled: false,
    checkedAt: "2026-08-25T00:00:00.000Z",
    desiredPackages: ["jq=1.7"],
    activePackages: ["jq=1.7"],
    desiredActiveDrift: false,
    configurationValid: true,
    configurationErrors: [],
    issues: [],
    images: [{
      baseImage: "propr/agent:test",
      recordedImage: "propr/runtime-agent:test",
      resolvedImage: "propr/runtime-agent:test",
      packages: [],
      issues: healthy ? [] : [{ code: "package_missing", message: "jq=1.7 is not installed" }],
      healthy,
    }],
    remediation: healthy ? undefined : "Run `propr runtime packages apply --wait`, then verify again.",
  };
}

test("runtime package verification prints actionable human output and returns a failing exit status", t => {
  const lines: string[] = [];
  t.mock.method(console, "log", (line: string) => { lines.push(line); });
  const result = verificationResult(false);

  printRuntimePackageVerification(result);

  assert.equal(runtimePackageVerificationExitCode(result), 1);
  assert.match(lines.join("\n"), /UNHEALTHY/);
  assert.match(lines.join("\n"), /jq=1\.7 is not installed/);
  assert.match(lines.join("\n"), /runtime packages apply/);
});

test("runtime package verification emits the complete JSON result and succeeds when healthy", t => {
  const lines: string[] = [];
  t.mock.method(console, "log", (line: string) => { lines.push(line); });
  const result = verificationResult(true);

  printRuntimePackageVerification(result, true);

  assert.equal(runtimePackageVerificationExitCode(result), 0);
  assert.deepEqual(JSON.parse(lines.join("\n")), JSON.parse(JSON.stringify(result)));
});
