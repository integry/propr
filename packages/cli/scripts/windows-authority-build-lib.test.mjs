import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  WindowsHelperBuildError,
  WINDOWS_BUILD_TOOL_SIGNER_POLICY,
  WINDOWS_BUILD_TOOL_DEPENDENCY_POLICY,
  authorizeWindowsBuildToolDependencies,
  authorizeWindowsBuildToolSigner,
  canonicalWindowsBuildSourceBytes,
  fixedBuildDiagnostic,
  runBoundedBuildTool,
  validateNativeWindowsDirectories,
} from "./windows-authority-build-lib.mjs";

test("security-pinned source bytes are canonical across clean LF and CRLF checkouts", () => {
  const lf = Buffer.from("first\nsecond\n", "utf8");
  const crlf = Buffer.from("first\r\nsecond\r\n", "utf8");
  const canonicalLf = canonicalWindowsBuildSourceBytes(lf);
  const canonicalCrlf = canonicalWindowsBuildSourceBytes(crlf);
  assert.deepEqual(canonicalLf, lf);
  assert.deepEqual(canonicalCrlf, lf);
  assert.deepEqual(canonicalCrlf, canonicalLf);
  assert.notEqual(canonicalCrlf, crlf);
});

test("canonical source binding rejects ambiguous bytes and stages only canonical bytes", () => {
  assert.throws(() => canonicalWindowsBuildSourceBytes(Buffer.from("first\rsecond\n")), WindowsHelperBuildError);
  assert.throws(() => canonicalWindowsBuildSourceBytes(Buffer.from([0x61, 0x00, 0x0a])), WindowsHelperBuildError);
  const source = readFileSync(new URL("../native/windows-authority-bootstrap.c", import.meta.url));
  const canonical = canonicalWindowsBuildSourceBytes(Buffer.from(source.toString("utf8").replaceAll("\n", "\r\n")));
  assert.deepEqual(canonical, source);
});

test("every pinned Windows and fixture source hashes the same canonical bytes that are compiled", () => {
  const pins = new Map([
    ["../native/windows-authority-bootstrap.c", "1b4dd2771e235bb1a4912095667f804a5611397b2706a4db1f7fe9357f7f975e"],
    ["../native/windows-authority-broker.c", "30347ad0d3bc382b115977439db72538afab176d34e59a68426060d7ba51c071"],
    ["../native/windows-authority-supervisor.cs", "68b38a53d073b032e9ed0c1f5e9c8a69c306b399524b654a691e3eb13d271aff"],
    ["../../../scripts/fixtures/windows-connect-docker-fixture.c", "3dac9791aa8c9f1dbe6f731bd72277e2b551bac94b72e50c66b71cb87164556c"],
    ["../../../test/fixtures/windowsAuthorityReplacementAttacker.c", "01ccc521cf6784f92cc33bbc4846b218625d61cb3b7dcbd9ed9366f50d12f6fa"],
  ]);
  for (const [relative, expected] of pins) {
    const lf = canonicalWindowsBuildSourceBytes(readFileSync(new URL(relative, import.meta.url)));
    const crlf = canonicalWindowsBuildSourceBytes(Buffer.from(lf.toString("utf8").replaceAll("\n", "\r\n")));
    assert.deepEqual(crlf, lf, `${relative} CRLF checkout changed compiled bytes`);
    assert.equal(createHash("sha256").update(lf).digest("hex"), expected, `${relative} pin drifted`);
  }
});

test("build tools require a fixed reviewed leaf and SPKI before authorization", () => {
  for (const [role, expected] of Object.entries(WINDOWS_BUILD_TOOL_SIGNER_POLICY)) {
    assert.deepEqual(authorizeWindowsBuildToolSigner(role, { signatureKind: "E", ...expected }), {
      signatureKind: "E", ...expected,
    });
    assert.throws(() => authorizeWindowsBuildToolSigner(role, {
      signatureKind: "E", ...expected, authenticodeLeafSha256: "0".repeat(64),
    }), WindowsHelperBuildError, `${role} accepted a same-subject/same-root wrong leaf`);
    assert.throws(() => authorizeWindowsBuildToolSigner(role, {
      signatureKind: "E", ...expected, authenticodeSpkiSha256: "f".repeat(64),
    }), WindowsHelperBuildError, `${role} accepted a wrong signing key`);
    assert.throws(() => authorizeWindowsBuildToolSigner(role, {
      signatureKind: "C", ...expected,
    }), WindowsHelperBuildError, `${role} accepted a replacement catalog trust mode`);
  }
  assert.throws(() => authorizeWindowsBuildToolSigner("unknown", {
    signatureKind: "E",
    authenticodeLeafSha256: "0".repeat(64),
    authenticodeSpkiSha256: "0".repeat(64),
  }), WindowsHelperBuildError);
});

test("compiler and linker module/config inventories are fixed before launch", () => {
  for (const [role, expected] of Object.entries(WINDOWS_BUILD_TOOL_DEPENDENCY_POLICY)) {
    assert.deepEqual(authorizeWindowsBuildToolDependencies(role, expected), expected);
    assert.throws(() => authorizeWindowsBuildToolDependencies(role, {
      ...expected, sha256: "0".repeat(64),
    }), WindowsHelperBuildError, `${role} accepted a dependent module/config swap`);
    assert.throws(() => authorizeWindowsBuildToolDependencies(role, {
      ...expected, files: expected.files + 1,
    }), WindowsHelperBuildError, `${role} accepted a dependent module insertion`);
  }
});

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
  const bootstrapSource = readFileSync(new URL("../native/windows-authority-bootstrap.c", import.meta.url), "utf8");
  assert.equal(buildSource.includes("PROPR_WINDOWS_AUTHENTICODE_LEAF_SHA256"), false);
  assert.equal(buildSource.includes("PROPR_WINDOWS_AUTHENTICODE_SPKI_SHA256"), false);
  assert.match(buildSource, /--print-signing-pins-v1/u);
  assert.match(buildSource, /Propr\.WindowsAuthority\.SigningPins/u);
  assert.doesNotMatch(buildSource, /SignerCertificate\.Subject-notmatch/u);
  assert.match(buildSource, /authorizeWindowsBuildToolSigner/u);
  assert.doesNotMatch(buildSource, /Test-AuthorizedMicrosoftFile/u);
  assert.match(buildSource, /Test-AuthorizedResolverFile/u);
  assert.match(buildSource, /runAuthorityLeasedBuildTool\(nativeLinker, nativeLinkArgs/u);
  assert.match(buildSource, /lease-build-inputs-v1/u);
  assert.match(buildSource, /input\.tool === true \|\| prior\.tool !== true/u);
  assert.match(buildSource, /signer-pins-v1/u);
  assert.match(buildSource, /authenticodeLeafSha256/u);
  assert.match(buildSource, /authenticodeSpkiSha256/u);
  assert.match(buildSource, /toolSigners/u);
  assert.doesNotMatch(bootstrapSource, /verify_authenticode_pins\(path, NULL, NULL\)/u);
  assert.match(bootstrapSource, /bytes\[offset \+ 67\] != 'E'/u);
  assert.match(buildSource, /nativeInputInventories\.slice/u);
  assert.doesNotMatch(buildSource, /PATH: `\$\{dirname\(nativeCompiler\)\}/u);
  assert.match(buildSource, /connect-authority-bootstrap\.exe/u);
  assert.match(buildSource, /bootstrapSourceSha256/u);
  assert.match(buildSource, /bootstrapSha256/u);
  assert.doesNotMatch(buildSource, /runBoundedBuildTool\(launcherOutput, \["system-paths-v1"\]/u);
  assert.match(buildSource, /publishWindowsBuildArtifactNoReplace\(temporaryOutput, output\)/u);
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
