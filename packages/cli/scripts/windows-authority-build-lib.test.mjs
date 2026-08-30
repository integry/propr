import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  WindowsHelperBuildError,
  WINDOWS_HELPER_DIAGNOSTICS,
  WINDOWS_BUILD_TOOL_SIGNER_POLICY,
  WINDOWS_BUILD_TOOL_DEPENDENCY_POLICY,
  WINDOWS_BUILD_TOOLCHAIN_PROFILES,
  assertModernRoslynVersion,
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

const windowsBuildSource = readFileSync(new URL("./build-windows-authority-helper.mjs", import.meta.url), "utf8");

function markedPowerShellSection(name) {
  const startMarker = `# BEGIN ${name}`;
  const endMarker = `# END ${name}`;
  const start = windowsBuildSource.indexOf(startMarker);
  const end = windowsBuildSource.indexOf(endMarker);
  assert.ok(start >= 0 && end > start, `${name} production PowerShell section is missing`);
  return windowsBuildSource.slice(start + startMarker.length, end);
}

function runWindowsPowerShell(script, environment = {}) {
  const directory = mkdtempSync(join(tmpdir(), "propr-vs-inventory-"));
  const scriptPath = join(directory, "test.ps1");
  try {
    writeFileSync(scriptPath, script, "utf8");
    const powershell = join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const result = spawnSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath], {
      encoding: "utf8",
      env: { SystemRoot: process.env.SystemRoot, ...environment },
      timeout: 10_000,
      windowsHide: true,
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, `PowerShell test failed: ${result.stderr}`);
    assert.equal(result.stderr, "");
    return result.stdout;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("hosted x64 and ARM64 compiler families are finite reviewed profiles", () => {
  assert.deepEqual(WINDOWS_BUILD_TOOLCHAIN_PROFILES, {
    "vs2026-18.9-x64": {
      visualStudioRange: "[18.9,18.10)", visualStudioPathFamily: "VisualStudio/18",
      visualStudioVersion: "18.9.12112.369", roslynVersion: "5.900.26.35703",
      msvcVersion: "14.51.36231", msvcProductVersion: "14.51.36256.0", runnerArchitecture: "x64",
    },
    "vs2026-18.9-arm64": {
      visualStudioRange: "[18.9,18.10)", visualStudioPathFamily: "VisualStudio/18",
      visualStudioVersion: "18.9.12112.369", roslynVersion: "5.900.26.35703",
      msvcVersion: "14.51.36231", msvcProductVersion: "14.51.36256.0", runnerArchitecture: "arm64",
    },
    "vs2022-17.14-x64": {
      visualStudioRange: "[17.14,17.15)", visualStudioPathFamily: "VisualStudio/2022/17.14",
      visualStudioVersion: "17.14.37502.11", roslynVersion: "4.14", msvcVersion: "14.44",
      msvcProductVersion: "14.44", runnerArchitecture: "x64",
    },
  });
  assert.doesNotThrow(() => assertModernRoslynVersion("5.900.26.35703", "vs2026-18.9-x64"));
  assert.doesNotThrow(() => assertModernRoslynVersion("5.900.26.35703", "vs2026-18.9-arm64"));
  assert.doesNotThrow(() => assertModernRoslynVersion("4.14.0.0", "vs2022-17.14-x64"));
  for (const version of ["5.900.26.35704", "5.10.0.0", "6.0.0.0", "4.15.0.0"]) {
    assert.throws(() => assertModernRoslynVersion(version, "vs2026-18.9-x64"), WindowsHelperBuildError);
  }
  const source = windowsBuildSource;
  assert.equal(source.match(/-all -prerelease -products \* -format json -utf8/g)?.length, 1);
  assert.doesNotMatch(source, /\$vswhere[^\n]*(?:-requires|-version|-latest|-property)/u);
  assert.match(source, /\$stdout\.Length\+\$count-gt65536/u);
  assert.match(source, /\$rawInstances\.Count-gt16/u);
  assert.match(source, /\$totalProperties\.Value-gt1024/u);
  assert.match(source, /\$properties\.Count-gt64/u);
  assert.match(source, /channelPathProperty/u);
  assert.match(source, /Only these reviewed security fields survive metadata validation/u);
  assert.doesNotMatch(source, /\$process\.WaitForExit\(\)/u);
  assert.match(source, /\$process\.WaitForExit\(\$remaining\)/u);
  const vswhereAuthorization = source.indexOf("if(-not(Test-AuthorizedResolverFile $vswhere)){exit 32}");
  const vswhereInventory = source.indexOf("$inventoryResult=Invoke-BoundedVswhereInventory $vswhere");
  assert.ok(vswhereAuthorization >= 0 && vswhereInventory > vswhereAuthorization,
    "vswhere inventory ran before the fixed signer/subject authorization");
  assert.match(source, /Microsoft\.VisualStudio\.Product\.Enterprise/u);
  assert.match(source, /installationVersion-ceq'18\.9\.12112\.369'/u);
  assert.match(source, /VS_ENTERPRISE_(?:ZERO|AMBIGUOUS|UNEXPECTED)/u);
  assert.match(source, /\[IO\.Path\]::Combine\(\$programFiles,'Microsoft Visual Studio','18','Enterprise'\)/);
  assert.match(source, /\[string\]::Equals\(\$_\.installationPath,\$expected18,\[StringComparison\]::OrdinalIgnoreCase\)/);
  assert.equal(source.includes("-version '[18.0,19.0)'"), false);
});

function realisticVswhereInstance(overrides = {}) {
  return {
    instanceId: "f17e91ce",
    installDate: "2026-08-12T18:22:31Z",
    installationName: "VisualStudio/18.9.0+12112.369",
    installationPath: "C:\\Program Files\\Microsoft Visual Studio\\18\\Enterprise",
    installationVersion: "18.9.12112.369",
    productId: "Microsoft.VisualStudio.Product.Enterprise",
    productPath: "C:\\Program Files\\Microsoft Visual Studio\\18\\Enterprise\\Common7\\IDE\\devenv.exe",
    state: 4294967295,
    isComplete: true,
    isLaunchable: true,
    isPrerelease: true,
    isRebootRequired: false,
    displayName: "Visual Studio Enterprise 2026 Insiders",
    description: "Microsoft DevOps solution for productivity and coordination across teams",
    channelId: "VisualStudio.18.Release",
    channelPath: "C:\\ProgramData\\Microsoft\\VisualStudio\\Packages\\_Channels\\18\\channelManifest.json",
    channelUri: "https://aka.ms/vs/18/release/channel",
    enginePath: "C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\resources\\app\\ServiceHub\\Services\\Microsoft.VisualStudio.Setup.Service",
    installChannelUri: "https://aka.ms/vs/18/release/channel",
    installedChannelId: "VisualStudio.18.Release",
    installedChannelUri: "https://aka.ms/vs/18/release/channel",
    releaseNotes: "https://learn.microsoft.com/visualstudio/releases/18/release-notes",
    resolvedInstallationPath: "C:\\Program Files\\Microsoft Visual Studio\\18\\Enterprise",
    thirdPartyNotices: "https://go.microsoft.com/fwlink/?LinkId=661288",
    updateDate: "2026-08-12T18:22:31.0000000Z",
    catalog: {
      buildBranch: "d18.9",
      buildVersion: "18.9.12112.369",
      productDisplayVersion: "18.9.0 Insiders",
      productLineVersion: "18",
    },
    properties: {
      campaignId: "2030:runner",
      channelManifestId: "VisualStudio.18.Release/18.9.0+12112.369",
      includeRecommended: "1",
      nickname: "",
    },
    futureScalarMetadata: "accepted-after-authentication",
    futureMetadataBag: { revision: "1", enabled: true },
    ...overrides,
  };
}

function inspectVswhereText(text) {
  const encoded = Buffer.from(text, "utf8").toString("base64");
  const output = runWindowsPowerShell(`${markedPowerShellSection("BOUNDED_VSWHERE_SCHEMA")}
$text=[Text.UTF8Encoding]::new($false,$true).GetString([Convert]::FromBase64String($env:PROPR_TEST_INVENTORY))
try{
  $rawInstances=@($text|ConvertFrom-Json)
  if($rawInstances.Count-gt16){throw [IO.InvalidDataException]::new()}
  $propertyCount=0
  $instances=@()
  foreach($rawInstance in $rawInstances){$instances+=@(ConvertTo-BoundedInventoryInstance $rawInstance ([ref]$propertyCount))}
  $selection=Select-ReviewedEnterpriseInventory $instances 'C:\\Program Files' 'x64'
  [Console]::Out.Write(($selection|ConvertTo-Json -Compress -Depth 4))
}catch{[Console]::Out.Write('VS_INVENTORY_SCHEMA')}
`, { PROPR_TEST_INVENTORY: encoded });
  return output === "VS_INVENTORY_SCHEMA" ? output : JSON.parse(output);
}

function inspectVswhereDocument(document) {
  return inspectVswhereText(JSON.stringify(document));
}

test("realistic complete vswhere 3.1.7 inventory accepts bounded channelPath and harmless metadata", {
  skip: process.platform !== "win32",
}, () => {
  const result = inspectVswhereDocument([realisticVswhereInstance()]);
  assert.equal(result.reason, null);
  assert.equal(result.profile, "vs2026-18.9-x64");
  assert.deepEqual(Object.keys(result.selected).sort(), [
    "instanceId", "productId", "installationPath", "installationVersion", "isComplete", "isLaunchable",
  ].sort());
});

test("bounded vswhere schema rejects bad channelPath, exact-field types, deep nesting, names, scalars, and instance overflow", {
  skip: process.platform !== "win32",
}, () => {
  const invalid = [
    [realisticVswhereInstance({ channelPath: true })],
    [realisticVswhereInstance({ isComplete: "true" })],
    [realisticVswhereInstance({ futureMetadataBag: { nested: { abuse: "x" } } })],
    [realisticVswhereInstance({ ["n".repeat(129)]: "x" })],
    [realisticVswhereInstance({ futureScalarMetadata: "x".repeat(2049) })],
    [realisticVswhereInstance(Object.fromEntries(Array.from({ length: 30 }, (_, outer) => [
      `futureBag${outer}`,
      Object.fromEntries(Array.from({ length: 40 }, (_, inner) => [`property${inner}`, "x"])),
    ])))],
    Array.from({ length: 17 }, (_, index) => realisticVswhereInstance({ instanceId: `instance-${index}` })),
  ];
  for (const document of invalid) assert.equal(inspectVswhereDocument(document), "VS_INVENTORY_SCHEMA");
  assert.equal(inspectVswhereText("[{]"), "VS_INVENTORY_SCHEMA");
});

test("multiple Enterprise installs are fatal before reviewed candidate filtering", {
  skip: process.platform !== "win32",
}, () => {
  const result = inspectVswhereDocument([
    realisticVswhereInstance(),
    realisticVswhereInstance({
      instanceId: "old-enterprise",
      installationPath: "C:\\Program Files\\Microsoft Visual Studio\\16\\Enterprise",
      installationVersion: "16.11.0.0",
    }),
  ]);
  assert.equal(result.reason, "VS_ENTERPRISE_AMBIGUOUS");
  assert.equal(result.selected, null);
});

function runBoundedInventoryProcessScenario(scenario, timeoutMilliseconds = 500) {
  const directory = mkdtempSync(join(tmpdir(), "propr-vswhere-child-"));
  const childPath = join(directory, "child.js");
  const pidPath = join(directory, "pid.txt");
  try {
    writeFileSync(childPath, `
const { writeFileSync } = require("node:fs");
writeFileSync(process.env.PROPR_TEST_PID_FILE, String(process.pid));
const scenario = process.argv[2];
if (scenario === "slow-valid") {
  process.stdout.write("[");
  setTimeout(() => process.stdout.end("]"), 80);
} else if (scenario === "partial-utf8") {
  process.stdout.write(Buffer.from([0x5b, 0x22, 0xc3]));
} else if (scenario === "split-utf8") {
  process.stdout.write(Buffer.from([0x5b, 0x22, 0xc3]));
  setTimeout(() => process.stdout.end(Buffer.from([0xa9, 0x22, 0x5d])), 25);
} else if (scenario === "stderr") {
  process.stdout.write("[]");
  process.stderr.write("bounded failure");
} else if (scenario === "stdout-oversize") {
  process.stdout.write(Buffer.alloc(65537, 0x61));
} else if (scenario === "stderr-oversize") {
  process.stdout.write("[]");
  process.stderr.write(Buffer.alloc(4097, 0x61));
} else if (scenario === "close-streams-hang") {
  process.stdout.end("[]");
  process.stderr.end();
  setInterval(() => {}, 1000);
} else if (scenario === "timeout") {
  setInterval(() => {}, 1000);
} else {
  process.exitCode = 2;
}
`, "utf8");
    const started = Date.now();
    const output = runWindowsPowerShell(`${markedPowerShellSection("BOUNDED_VSWHERE_PROCESS")}
$start=[Diagnostics.ProcessStartInfo]::new()
$start.FileName=$env:PROPR_TEST_NODE
$start.Arguments=('"'+$env:PROPR_TEST_CHILD+'" '+$env:PROPR_TEST_SCENARIO)
$start.UseShellExecute=$false
$start.CreateNoWindow=$true
$start.RedirectStandardOutput=$true
$start.RedirectStandardError=$true
$result=Invoke-BoundedRedirectedInventoryProcess $start ${timeoutMilliseconds}
$document=[ordered]@{reason=$result.reason;bytes=$(if($null-eq$result.bytes){$null}else{[Convert]::ToBase64String($result.bytes)})}
[Console]::Out.Write(($document|ConvertTo-Json -Compress))
`, {
      PROPR_TEST_NODE: process.execPath,
      PROPR_TEST_CHILD: childPath,
      PROPR_TEST_SCENARIO: scenario,
      PROPR_TEST_PID_FILE: pidPath,
    });
    const pid = Number(readFileSync(pidPath, "utf8"));
    let alive = true;
    try { process.kill(pid, 0); } catch { alive = false; }
    return { ...JSON.parse(output), alive, elapsed: Date.now() - started };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("bounded vswhere read accepts slow valid stdout under one deadline", {
  skip: process.platform !== "win32",
}, () => {
  const result = runBoundedInventoryProcessScenario("slow-valid", 1_000);
  assert.equal(result.reason, null);
  assert.equal(Buffer.from(result.bytes, "base64").toString("utf8"), "[]");
  assert.equal(result.alive, false);
});

test("bounded vswhere read preserves split UTF-8 and rejects a truncated partial scalar", {
  skip: process.platform !== "win32",
}, () => {
  const split = runBoundedInventoryProcessScenario("split-utf8");
  assert.equal(split.reason, null);
  assert.equal(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(split.bytes, "base64")), "[\"é\"]");
  assert.equal(split.alive, false);
  const truncated = runBoundedInventoryProcessScenario("partial-utf8");
  assert.equal(truncated.reason, null);
  assert.throws(() => new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(truncated.bytes, "base64")));
  assert.equal(truncated.alive, false);
});

test("bounded vswhere read rejects any stderr under its independent 4 KiB cap", {
  skip: process.platform !== "win32",
}, () => {
  const stderr = runBoundedInventoryProcessScenario("stderr");
  assert.equal(stderr.reason, "VS_INVENTORY_TOOL");
  assert.equal(stderr.bytes, null);
  assert.equal(stderr.alive, false);
  const oversized = runBoundedInventoryProcessScenario("stderr-oversize");
  assert.equal(oversized.reason, "VS_INVENTORY_OVERSIZED");
  assert.equal(oversized.bytes, null);
  assert.equal(oversized.alive, false);
});

test("bounded vswhere read rejects stdout beyond its independent 64 KiB cap", {
  skip: process.platform !== "win32",
}, () => {
  const result = runBoundedInventoryProcessScenario("stdout-oversize");
  assert.equal(result.reason, "VS_INVENTORY_OVERSIZED");
  assert.equal(result.bytes, null);
  assert.equal(result.alive, false);
});

test("bounded vswhere read kills a child that closes both streams then hangs", {
  skip: process.platform !== "win32",
}, () => {
  const result = runBoundedInventoryProcessScenario("close-streams-hang", 150);
  assert.equal(result.reason, "VS_INVENTORY_TOOL");
  assert.equal(result.alive, false);
  assert.ok(result.elapsed < 3_000, `close-stream hang cleanup took ${result.elapsed}ms`);
});

test("bounded vswhere timeout settles pending reads and process cleanup", {
  skip: process.platform !== "win32",
}, () => {
  const result = runBoundedInventoryProcessScenario("timeout", 150);
  assert.equal(result.reason, "VS_INVENTORY_TOOL");
  assert.equal(result.alive, false);
  assert.ok(result.elapsed < 3_000, `timeout cleanup took ${result.elapsed}ms`);
});

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

test("natural inventory failures have distinct fixed secret-free diagnostics and cannot satisfy mutation evidence", () => {
  const reasons = [
    "VS_INVENTORY_TOOL",
    "VS_INVENTORY_OVERSIZED",
    "VS_INVENTORY_SCHEMA",
    "VS_ENTERPRISE_ZERO",
    "VS_ENTERPRISE_AMBIGUOUS",
    "VS_ENTERPRISE_UNEXPECTED",
  ];
  assert.deepEqual(WINDOWS_HELPER_DIAGNOSTICS.slice(12), reasons);
  reasons.forEach((reason, offset) => {
    const error = new WindowsHelperBuildError("BUILD_COMPILER", reason, new Error("C:\\secret\\inventory.json"));
    assert.equal(fixedBuildDiagnostic(error), `[win-authority-stage:BUILD_COMPILER:${12 + offset}]`);
    assert.equal(error.message.includes("secret"), false);
  });
  assert.match(windowsBuildSource, /new WindowsHelperBuildError\("BUILD_COMPILER", resolvedToolchain\.profileMismatch\)/u);
  const verifier = readFileSync(new URL("../../../scripts/verify-windows-authority-build-evidence.mjs", import.meta.url), "utf8");
  assert.match(verifier, /\[\["BUILD_COMPILER", 6\], \["BUILD_SOURCE", 6\], \["BUILD_OUTPUT", 6\]\]/u);
  assert.doesNotMatch(verifier, /VS_(?:INVENTORY|ENTERPRISE)/u);
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
    ["../native/windows-connect-authority-service.cs", "512c4716be5396877360e6011c2a3034d58305d676c0db950120c47f2009fe0c"],
    ["../native/windows-connect-authority.wxs", "3f3d7034b47bbf1ad7100cdb5ce4bce9360e6479669629a5452c23b4eefc77e6"],
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
  for (const [profile, policy] of Object.entries(WINDOWS_BUILD_TOOL_SIGNER_POLICY)) {
    if (profile === "sign-tool") continue;
    for (const [role, expected] of Object.entries(policy)) {
    assert.deepEqual(authorizeWindowsBuildToolSigner(profile, role, { signatureKind: "E", ...expected }), {
      signatureKind: "E", ...expected,
    });
    assert.throws(() => authorizeWindowsBuildToolSigner(profile, role, {
      signatureKind: "E", ...expected, authenticodeLeafSha256: "0".repeat(64),
    }), WindowsHelperBuildError, `${role} accepted a same-subject/same-root wrong leaf`);
    assert.throws(() => authorizeWindowsBuildToolSigner(profile, role, {
      signatureKind: "E", ...expected, authenticodeSpkiSha256: "f".repeat(64),
    }), WindowsHelperBuildError, `${role} accepted a wrong signing key`);
    assert.throws(() => authorizeWindowsBuildToolSigner(profile, role, {
      signatureKind: "C", ...expected,
    }), WindowsHelperBuildError, `${role} accepted a replacement catalog trust mode`);
    }
  }
  assert.throws(() => authorizeWindowsBuildToolSigner("unknown", "compiler", {
    signatureKind: "E",
    authenticodeLeafSha256: "0".repeat(64),
    authenticodeSpkiSha256: "0".repeat(64),
  }), WindowsHelperBuildError);
});

test("compiler and linker module/config inventories are fixed before launch", () => {
  for (const [profile, policy] of Object.entries(WINDOWS_BUILD_TOOL_DEPENDENCY_POLICY)) {
    if (profile === "wix-runtime") continue;
    for (const [role, expected] of Object.entries(policy)) {
    assert.deepEqual(authorizeWindowsBuildToolDependencies(profile, role, expected), expected);
    assert.throws(() => authorizeWindowsBuildToolDependencies(profile, role, {
      ...expected, sha256: "0".repeat(64),
    }), WindowsHelperBuildError, `${role} accepted a dependent module/config swap`);
    assert.throws(() => authorizeWindowsBuildToolDependencies(profile, role, {
      ...expected, files: expected.files + 1,
    }), WindowsHelperBuildError, `${role} accepted a dependent module insertion`);
    }
  }
});

test("service replay capacity never evicts an unexpired identity-scoped ID", () => {
  const source = readFileSync(new URL("../native/windows-connect-authority-service.cs", import.meta.url), "utf8");
  assert.match(source, /new ReplayWindow\(1024, 768, TimeSpan\.FromMinutes\(2\)\)/u);
  assert.match(source, /active\.Count \+ recent\.Count >= capacity/u);
  assert.match(source, /identityCount >= identityCapacity/u);
  assert.match(source, /recent\.Add\(key, new ReplayEntry\(identity, checked\(now \+ lifetimeTicks\)\)\)/u);
  assert.doesNotMatch(source, /recent\.OrderBy|recent\.Remove\(oldest\)/u);
  assert.match(source, /if \(bounded\.TryAcquire\("user-a", "f{32}"\)\) return false;/u);
  assert.match(source, /now = 11 \* Stopwatch\.Frequency;/u);
  assert.match(source, /Parallel\.For\(0, 64/u);
  assert.match(source, /ReplayWindow isolated = new ReplayWindow\(4, 2/u);
  assert.match(source, /foreach \(string id in operationReplayIds\) replay\.Complete\(replayIdentity, id\)/u);
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
