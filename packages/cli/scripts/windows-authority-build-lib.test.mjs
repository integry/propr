import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  WindowsHelperBuildError,
  fixedBuildDiagnostic,
  runBoundedBuildTool,
  validateNativeWindowsDirectories,
} from "./windows-authority-build-lib.mjs";

function result(overrides = {}) {
  return {
    pid: 1,
    output: [],
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    status: 0,
    signal: null,
    error: undefined,
    ...overrides,
  };
}

function expectDiagnostic(expected, fake) {
  assert.throws(
    () => runBoundedBuildTool("C:\\secret\\csc.exe", ["C:\\secret\\source.cs"], {
      stage: "BUILD_COMPILER",
      sensitiveValues: ["C:\\secret\\csc.exe", "C:\\secret\\source.cs", "swordfish"],
      spawnSyncImpl: () => fake,
    }),
    (error) => {
      assert.equal(error instanceof WindowsHelperBuildError, true);
      assert.equal(error.diagnostic, expected);
      assert.match(fixedBuildDiagnostic(error), /^\[win-authority-stage:BUILD_COMPILER:\d+\]$/u);
      assert.equal(error.message.includes("secret"), false);
      assert.equal(error.message.includes("swordfish"), false);
      return true;
    },
  );
}

test("compiler bad flag is a fixed diagnostic", () => {
  expectDiagnostic("BAD_FLAG", result({
    status: 1,
    stderr: Buffer.from("C:\\secret\\source.cs: error CS2007: Unrecognized option 'swordfish'"),
  }));
});

test("compiler syntax error is a fixed diagnostic", () => {
  expectDiagnostic("SYNTAX_ERROR", result({
    status: 1,
    stdout: Buffer.from("C:\\secret\\source.cs(1,1): error CS1002: ; expected"),
  }));
});

test("missing compiler reference is a fixed diagnostic", () => {
  expectDiagnostic("MISSING_REFERENCE", result({
    status: 1,
    stderr: Buffer.from("error CS0006: Metadata file 'C:\\secret\\reference.dll' could not be found"),
  }));
});

test("stalled compiler is a fixed diagnostic", () => {
  const error = Object.assign(new Error("spawn timed out at C:\\secret\\csc.exe"), { code: "ETIMEDOUT" });
  expectDiagnostic("STALLED", result({ status: null, signal: "SIGKILL", error }));
});

test("oversized compiler output is a fixed diagnostic", () => {
  expectDiagnostic("OVERSIZED_OUTPUT", result({
    status: null,
    error: Object.assign(new Error("maxBuffer exceeded"), { code: "ENOBUFS" }),
  }));
});

test("empty-output nonzero compiler exit is a fixed diagnostic", () => {
  expectDiagnostic("NONZERO_EMPTY_OUTPUT", result({ status: 1 }));
});

test("nonempty nonzero compiler exit never exposes compiler text", () => {
  expectDiagnostic("NONZERO_OUTPUT", result({
    status: 1,
    stderr: Buffer.from("fatal compiler failure C:\\secret\\source.cs swordfish"),
  }));
});

test("invalid UTF-8 compiler output is rejected before classification", () => {
  expectDiagnostic("INVALID_UTF8", result({ status: 1, stdout: Buffer.from([0xc3, 0x28]) }));
});

test("production signer pins cannot be copied from environment claims", () => {
  const buildSource = readFileSync(new URL("./build-windows-authority-helper.mjs", import.meta.url), "utf8");
  assert.equal(buildSource.includes("PROPR_WINDOWS_AUTHENTICODE_LEAF_SHA256"), false);
  assert.equal(buildSource.includes("PROPR_WINDOWS_AUTHENTICODE_SPKI_SHA256"), false);
  assert.match(buildSource, /--print-signing-pins-v1/u);
  assert.match(buildSource, /Propr\.WindowsAuthority\.SigningPins/u);
  assert.doesNotMatch(buildSource, /SignerCertificate\.Subject-notmatch/u);
  assert.match(buildSource, /Test-AuthorizedMicrosoftFile/u);
  assert.match(buildSource, /runBoundedBuildTool\(nativeLinker, nativeLinkArgs/u);
  assert.doesNotMatch(buildSource, /PATH: `\$\{dirname\(nativeCompiler\)\}/u);
});

test("native Windows directory authority accepts hosted and alternate-drive layouts", () => {
  for (const drive of ["C", "D", "Q"]) {
    assert.deepEqual(validateNativeWindowsDirectories({
      windowsDirectory: `${drive}:\\Windows`,
      systemWindowsDirectory: `${drive}:\\Windows`,
      systemDirectory: `${drive}:\\Windows\\System32`,
    }), {
      windowsDirectory: `${drive}:\\Windows`,
      systemWindowsDirectory: `${drive}:\\Windows`,
      systemDirectory: `${drive}:\\Windows\\System32`,
    });
  }
});

test("native Windows directory authority is independent of architecture and hostile environment roots", () => {
  for (const architecture of ["x64", "arm64"]) {
    const environment = { SystemRoot: "Z:\\attacker", windir: "Y:\\attacker", PROCESSOR_ARCHITECTURE: architecture };
    const resolved = validateNativeWindowsDirectories({
      windowsDirectory: "D:\\Windows",
      systemWindowsDirectory: "D:\\Windows",
      systemDirectory: "D:\\Windows\\System32",
    });
    assert.equal(resolved.windowsDirectory, "D:\\Windows");
    assert.notEqual(resolved.windowsDirectory, environment.SystemRoot);
    assert.notEqual(resolved.windowsDirectory, environment.windir);
  }
});

test("native Windows directory authority rejects aliases, UNC roots, and disagreements", () => {
  for (const candidate of [
    { windowsDirectory: "C:\\Windows", systemWindowsDirectory: "D:\\Windows", systemDirectory: "C:\\Windows\\System32" },
    { windowsDirectory: "C:\\Windows", systemWindowsDirectory: "C:\\Windows", systemDirectory: "D:\\Windows\\System32" },
    { windowsDirectory: "\\\\?\\GLOBALROOT\\SystemRoot", systemWindowsDirectory: "\\\\?\\GLOBALROOT\\SystemRoot", systemDirectory: "C:\\Windows\\System32" },
    { windowsDirectory: "\\\\server\\Windows", systemWindowsDirectory: "\\\\server\\Windows", systemDirectory: "\\\\server\\Windows\\System32" },
    { windowsDirectory: "C:\\Windows\\..\\attacker", systemWindowsDirectory: "C:\\Windows\\..\\attacker", systemDirectory: "C:\\attacker\\System32" },
  ]) assert.throws(() => validateNativeWindowsDirectories(candidate), WindowsHelperBuildError);
});
