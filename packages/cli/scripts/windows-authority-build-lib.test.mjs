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
  awaitWindowsBuildLeaseReadiness,
  canonicalWindowsBuildSourceBytes,
  createWindowsBuildProgressValidator,
  fixedBuildDiagnostic,
  formatWindowsBuildProgressFrame,
  planWindowsBuildLeaseReadiness,
  runBoundedBuildTool,
  runBoundedProgressBuildTool,
  validateNativeWindowsDirectories,
  windowsBuildLeaseProgressFrames,
} from "./windows-authority-build-lib.mjs";

test("x64 and arm64 slow-host lease readiness is inventory-sized and hard bounded", async () => {
  for (const architecture of ["x64", "arm64"]) {
    const plan = planWindowsBuildLeaseReadiness(Array.from({ length: 1537 }, (_, index) => ({
      architecture,
      path: `input-${index}`,
      bytes: index === 0 ? 256 * 1024 * 1024 : 4096,
    })));
    assert.deepEqual(plan.stages, ["INVENTORY", "LEASE_BATCH", "READY"]);
    assert.equal(plan.files, 1537);
    assert.ok(plan.batches.length >= 4);
    assert.ok(plan.batches.every((batch) => batch.length <= 512));
    assert.ok(plan.deadlineMs > 10_000, `${architecture} retained the obsolete ten-second deadline`);
    assert.ok(plan.deadlineMs <= 180_000, `${architecture} readiness lost its hard deadline`);
    const progress = windowsBuildLeaseProgressFrames(plan);
    await awaitWindowsBuildLeaseReadiness(progress.slice(1, -1).map((frame) => Promise.resolve(frame)), plan);
  }
});

test("runtime lease progress rejects duplicate, regression, counter overflow, and missing frames", () => {
  const plan = planWindowsBuildLeaseReadiness([
    { path: "one", bytes: 7 },
    { path: "two", bytes: 8 },
  ]);
  const frames = windowsBuildLeaseProgressFrames(plan);
  const duplicate = createWindowsBuildProgressValidator(frames);
  duplicate.push(frames[0]);
  assert.throws(() => duplicate.push(frames[0]), WindowsHelperBuildError);
  const missing = createWindowsBuildProgressValidator(frames);
  missing.push(frames[0]);
  assert.throws(() => missing.finish(), (error) => error.diagnostic === "STALLED");
  assert.throws(() => createWindowsBuildProgressValidator(frames).push(
    "PROPR_BUILD_PROGRESS_V1 2/3 1/1 3/2 15/15\n",
  ), WindowsHelperBuildError);
  assert.throws(() => createWindowsBuildProgressValidator(frames).push(
    "PROPR_BUILD_PROGRESS_V1 2/3 1/1 1/2 999999999999999999999/15\n",
  ), WindowsHelperBuildError);
});

test("slow staged discovery progress completes under one realistic hard deadline", async () => {
  const frames = Array.from({ length: 3 }, (_, index) => formatWindowsBuildProgressFrame({
    stage: index + 1, stages: 3, batch: 0, batches: 0,
    files: 0, totalFiles: 0, bytes: 0, totalBytes: 0,
  }));
  const script = `const frames=${JSON.stringify(frames)};let i=0;const next=()=>{if(i===frames.length){process.stdout.write('ready');return;}process.stderr.write(frames[i++]);setTimeout(next,20)};next()`;
  const result = await runBoundedProgressBuildTool(process.execPath, ["-e", script], {
    progressFrames: frames, timeout: 1_000, maxBytes: 16, maxProgressBytes: 1024,
  });
  assert.equal(result.stdout.toString(), "ready");
});

test("intentional staged discovery stall is bounded by the one overall deadline", async () => {
  const frame = formatWindowsBuildProgressFrame({
    stage: 1, stages: 2, batch: 0, batches: 0,
    files: 0, totalFiles: 0, bytes: 0, totalBytes: 0,
  });
  await assert.rejects(runBoundedProgressBuildTool(process.execPath, ["-e",
    `process.stderr.write(${JSON.stringify(frame)});setInterval(()=>{},1000)`], {
    progressFrames: [frame, frame.replace("1/2", "2/2")], timeout: 50, maxBytes: 16,
  }), (error) => error instanceof WindowsHelperBuildError && error.diagnostic === "STALLED");
});

test("intentional lease-readiness stall remains BUILD_COMPILER diagnostic 4", async () => {
  const plan = planWindowsBuildLeaseReadiness([{ path: "stalled", bytes: 1 }]);
  let fire;
  const timer = { unref() {} };
  await assert.rejects(awaitWindowsBuildLeaseReadiness([new Promise(() => {})], plan, {
    setTimeoutImpl: (callback, delay) => {
      assert.equal(delay, plan.deadlineMs);
      fire = callback;
      queueMicrotask(callback);
      return timer;
    },
    clearTimeoutImpl: (value) => assert.equal(value, timer),
  }), (error) => {
    assert.equal(error instanceof WindowsHelperBuildError, true);
    assert.equal(error.diagnostic, "STALLED");
    assert.equal(fixedBuildDiagnostic(error), "[win-authority-stage:BUILD_COMPILER:4]");
    assert.equal(typeof fire, "function");
    return true;
  });
});

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
    ["../native/windows-authority-bootstrap.c", "9c78ab7d06b43dcee72420ec6442fc639b5542a8ef76be3a46d281843d43ef72"],
    ["../native/windows-authority-broker.c", "f5b29a4b2f8fbcce41690e2363d90440d73fbebb10114ec0eae53e9653f34a4c"],
    ["../native/windows-authority-supervisor.cs", "68b38a53d073b032e9ed0c1f5e9c8a69c306b399524b654a691e3eb13d271aff"],
    ["../native/windows-connect-authority-service.cs", "d192e97ac87d5d09188da0da9cca778ce9e9a578bd1bd22fc0b4d91a44b28d86"],
    ["../native/windows-connect-authority.wxs", "ea9c99b8f212e7deb6948172a7e3dae1a888147a2610deb6946904c863d7f6f8"],
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
  assert.match(buildSource, /planWindowsBuildLeaseReadiness/u);
  assert.match(buildSource, /awaitWindowsBuildLeaseReadiness/u);
  assert.match(buildSource, /await runBoundedProgressBuildTool\(trustedPowerShell/u);
  assert.match(buildSource, /timeout: 180_000/u);
  assert.doesNotMatch(buildSource, /timeout: 15_000/u);
  assert.match(buildSource, /signer-pins-v1", path\], \{\s*stage: "BUILD_COMPILER", timeout: 60_000/u);
  assert.match(buildSource, /lease-build-inputs-v1/u);
  assert.match(buildSource, /input\.tool === true \|\| prior\.tool !== true/u);
  assert.match(buildSource, /signer-pins-v1/u);
  assert.match(buildSource, /authenticodeLeafSha256/u);
  assert.match(buildSource, /authenticodeSpkiSha256/u);
  assert.match(buildSource, /toolSigners/u);
  assert.doesNotMatch(bootstrapSource, /verify_authenticode_pins\(path, NULL, NULL\)/u);
  assert.match(bootstrapSource, /bytes\[offset \+ 67\] != 'E'/u);
  const brokerSource = readFileSync(new URL("../native/windows-authority-broker.c", import.meta.url), "utf8");
  assert.match(brokerSource, /launch-bootstrap-v1/u);
  assert.match(brokerSource, /_get_osfhandle\(9\)/u);
  assert.match(brokerSource, /_get_osfhandle\(10\)/u);
  assert.match(brokerSource, /DuplicateHandle\(GetCurrentProcess\(\), self_lease/u);
  assert.match(brokerSource, /_dup2\(child_authority_fd, 6\)/u);
  assert.match(brokerSource, /PROC_THREAD_ATTRIBUTE_HANDLE_LIST/u);
  assert.match(brokerSource, /EXTENDED_STARTUPINFO_PRESENT/u);
  assert.match(brokerSource, /if \(child_authority_installed\) _close\(6\)/u);
  assert.doesNotMatch(brokerSource, /SetHandleInformation\(inherited_authority, HANDLE_FLAG_INHERIT, 0\)/u);
  assert.match(brokerSource, /CREATE_SUSPENDED \| CREATE_NO_WINDOW/u);
  assert.match(brokerSource, /verify_authenticode_pins\(self_path, expected_leaf, expected_spki\)/u);
  assert.match(brokerSource, /same_file_id\(&target_id, &loaded_id\)/u);
  assert.match(buildSource, /"crypt32\.lib"/u);
  assert.match(buildSource, /nativeInputInventories\.slice/u);
  assert.doesNotMatch(buildSource, /PATH: `\$\{dirname\(nativeCompiler\)\}/u);
  assert.match(buildSource, /connect-authority-bootstrap\.exe/u);
  assert.match(buildSource, /bootstrapSourceSha256/u);
  assert.match(buildSource, /bootstrapSha256/u);
  assert.doesNotMatch(buildSource, /runBoundedBuildTool\(launcherOutput, \["system-paths-v1"\]/u);
  assert.match(buildSource, /publishedOutput = publishOrVerifyBaseline\(temporaryOutput, output\)/u);
  assert.doesNotMatch(buildSource, /rmSync\(output, \{ force: true \}\);\s*rmSync\(manifestPath/u);
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
