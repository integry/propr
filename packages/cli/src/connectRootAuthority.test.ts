import assert from "node:assert/strict";
import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  assertNativeWindowsEntriesAuthority,
  assertSafeWindowsAuthority,
  assertWindowsInspectionShape,
  parseWindowsInspectionDocument,
  stableAuthorityIdentity,
  WindowsAuthorityInspectionError,
  WindowsAuthorityPolicyError,
  type ConnectRootAuthorityInspector,
  type WindowsAuthorityInspection,
} from "./connectRootAuthority.js";
import {
  parseWindowsNativeProbeOutput,
  WINDOWS_INSPECTION_CUMULATIVE_TIMEOUT_MS,
  WINDOWS_INSPECTION_SOURCE,
  WINDOWS_INSPECTION_TIMEOUT_MS,
  WINDOWS_INSPECTOR_CREATES_CHILD_PROCESSES,
  WINDOWS_INSPECTOR_TRANSPORT,
  WINDOWS_INSPECTOR_WRITES_FILESYSTEM,
  WINDOWS_NATIVE_TIMING_PROBE_SOURCE,
  WINDOWS_NATIVE_TIMING_PROBE_TIMEOUT_MS,
  windowsInspectionTimeoutForElapsed,
  WindowsNativeStageError,
  windowsNativeTimingBucket,
  windowsPowerShellEnvironment,
} from "./connectWindowsAuthority.js";

const USER = "S-1-5-21-100-200-300-1001";
const SYSTEM = "S-1-5-18";
const ADMINISTRATORS = "S-1-5-32-544";

function inspection(overrides: Partial<WindowsAuthorityInspection> = {}): WindowsAuthorityInspection {
  return {
    index: 0,
    kind: "directory",
    authorityKind: "root",
    currentUserSid: USER,
    ownerSid: USER,
    daclProtected: true,
    reparsePoint: false,
    volumeSerialNumber: "1",
    fileId: "2",
    verifiedVolumeSerialNumber: "1",
    verifiedFileId: "2",
    rules: [
      { identitySid: USER, inherited: false, accessType: "allow", appliesToSelf: true, rights: "2032127" },
      { identitySid: SYSTEM, inherited: false, accessType: "allow", appliesToSelf: true, rights: "2032127" },
      { identitySid: ADMINISTRATORS, inherited: false, accessType: "allow", appliesToSelf: true, rights: "2032127" },
    ],
    ...overrides,
  };
}

function policyFailure(
  value: WindowsAuthorityInspection,
  kind: Parameters<typeof assertSafeWindowsAuthority>[1],
  reason: string,
): void {
  assert.throws(
    () => assertSafeWindowsAuthority(value, kind),
    (error) => error instanceof WindowsAuthorityPolicyError && error.policyReason === reason,
  );
}

test("Windows protected entries allow only explicit trusted mutation authority", () => {
  assert.doesNotThrow(() => assertSafeWindowsAuthority(inspection(), "root"));
  policyFailure(inspection({
    rules: [{ identitySid: "S-1-1-0", inherited: false, accessType: "allow", appliesToSelf: true, rights: "2" }],
  }), "root", "BROAD_WRITE");
  policyFailure(inspection({
    rules: [{ identitySid: USER, inherited: true, accessType: "allow", appliesToSelf: true, rights: "2" }],
  }), "root", "INHERITED_WRITE");
  policyFailure(inspection({ daclProtected: false }), "data", "DACL_NOT_PROTECTED");
  policyFailure(inspection({ ownerSid: SYSTEM }), "env", "OWNER_MISMATCH");
  policyFailure(inspection({ reparsePoint: true }), "root", "REPARSE_POINT");
  policyFailure(inspection({
    rules: [{ identitySid: USER, inherited: false, accessType: "deny", appliesToSelf: true, rights: "4294967295" }],
  }), "root", "UNKNOWN_RIGHTS");
});

test("Windows ancestors narrowly allow OS ownership and inherited traversal", () => {
  assert.doesNotThrow(() => assertSafeWindowsAuthority(inspection({
    authorityKind: "ancestor",
    ownerSid: SYSTEM,
    daclProtected: false,
    rules: [{ identitySid: "S-1-5-32-545", inherited: true, accessType: "allow", appliesToSelf: true, rights: "1179785" }],
  }), "ancestor"));
  assert.doesNotThrow(() => assertSafeWindowsAuthority(inspection({
    authorityKind: "home",
    ownerSid: ADMINISTRATORS,
    daclProtected: false,
    rules: [{ identitySid: USER, inherited: true, accessType: "allow", appliesToSelf: true, rights: "2032127" }],
  }), "home"));
  policyFailure(inspection({
    authorityKind: "ancestor",
    ownerSid: SYSTEM,
    daclProtected: false,
    rules: [{ identitySid: "S-1-5-32-545", inherited: true, accessType: "allow", appliesToSelf: true, rights: "2" }],
  }), "ancestor", "BROAD_WRITE");
  policyFailure(inspection({ authorityKind: "ancestor", ownerSid: "S-1-5-80-123" }), "ancestor", "OWNER_MISMATCH");
});

test("Windows broker JSON is canonical, exact-keyed, and bounded", () => {
  const valid = JSON.stringify({ version: 1, entries: [inspection()] });
  assert.deepEqual(parseWindowsInspectionDocument(valid), [inspection()]);
  assertWindowsInspectionShape(parseWindowsInspectionDocument(valid)[0]);
  for (const malformed of [
    `${valid}\n`,
    `{"version":1,"version":1,"entries":[]}`,
    JSON.stringify({ version: 1, entries: [], extra: true }),
    JSON.stringify({ version: 2, entries: [] }),
    JSON.stringify({ version: 1, entries: Array.from({ length: 33 }, () => inspection()) }),
    "{",
  ]) assert.throws(
    () => parseWindowsInspectionDocument(malformed),
    (error) => error instanceof WindowsNativeStageError && error.stage === "parent:json-shape",
  );
  assert.throws(
    () => parseWindowsInspectionDocument("x".repeat(128 * 1024 + 1)),
    (error) => error instanceof WindowsNativeStageError && error.stage === "parent:utf8",
  );
  assert.throws(() => assertWindowsInspectionShape({ ...inspection(), extra: true }));
  assert.throws(() => assertWindowsInspectionShape({ ...inspection(), rules: [
    { identitySid: USER, inherited: false, accessType: "audit", appliesToSelf: true, rights: "1" },
  ] }));
});

test("Windows native timing milestones are strict, ordered, bounded, and redacted", () => {
  const valid = [
    "PROPR_NATIVE_PROBE_V1|entry-ps51-desktop-x64|under-5s",
    "PROPR_NATIVE_PROBE_V1|constant-json|under-5s",
    "PROPR_NATIVE_PROBE_V1|reflection-emit|5-to-15s",
    "PROPR_NATIVE_PROBE_V1|harmless-win32|5-to-15s",
    "PROPR_NATIVE_PROBE_V1|standard-handle-identity|15-to-30s",
    "",
  ].join("\r\n");
  assert.deepEqual(parseWindowsNativeProbeOutput(valid), [
    { milestone: "entry-ps51-desktop-x64", timingBucket: "under-5s" },
    { milestone: "constant-json", timingBucket: "under-5s" },
    { milestone: "reflection-emit", timingBucket: "5-to-15s" },
    { milestone: "harmless-win32", timingBucket: "5-to-15s" },
    { milestone: "standard-handle-identity", timingBucket: "15-to-30s" },
  ]);
  assert.deepEqual(parseWindowsNativeProbeOutput(valid.split("\r\n").slice(0, 3).join("\r\n") + "\r\n"), [
    { milestone: "entry-ps51-desktop-x64", timingBucket: "under-5s" },
    { milestone: "constant-json", timingBucket: "under-5s" },
    { milestone: "reflection-emit", timingBucket: "5-to-15s" },
  ]);
  assert.deepEqual(parseWindowsNativeProbeOutput(
    "PROPR_NATIVE_PROBE_V1|entry-ps51-desktop-x64|under-5s\r\npartial-SENTINEL",
    true,
  ), [{ milestone: "entry-ps51-desktop-x64", timingBucket: "under-5s" }]);
  for (const hostile of [
    "PROPR_NATIVE_PROBE_V1|constant-json|under-5s\r\n",
    "PROPR_NATIVE_PROBE_V1|entry-ps51-desktop-x64|arbitrary-12345ms\r\n",
    "C:\\private-path-SENTINEL S-1-5-21-999 raw-error-SENTINEL\r\n",
    "PROPR_NATIVE_PROBE_V1|entry-ps51-desktop-x64|under-5s",
    "x".repeat(2 * 1024 + 1),
  ]) assert.throws(
    () => parseWindowsNativeProbeOutput(hostile),
    (error) => error instanceof WindowsNativeStageError
      && error.stage === "probe:output"
      && !error.message.includes("SENTINEL"),
  );
});

test("Windows native timing uses only coarse fixed buckets", () => {
  assert.deepEqual([
    0, 4_999, 5_000, 14_999, 15_000, 29_999, 30_000, 44_999, 45_000, 59_999, 60_000,
  ].map(windowsNativeTimingBucket), [
    "under-5s", "under-5s", "5-to-15s", "5-to-15s", "15-to-30s", "15-to-30s",
    "30-to-45s", "30-to-45s", "45-to-60s", "45-to-60s", "at-least-60s",
  ]);
  assert.throws(() => windowsNativeTimingBucket(Number.NaN), WindowsNativeStageError);
});

test("Windows production inspection has one cold-start deadline and a cumulative batch cap", () => {
  assert.equal(WINDOWS_INSPECTION_TIMEOUT_MS, 30_000);
  assert.equal(WINDOWS_INSPECTION_CUMULATIVE_TIMEOUT_MS, 60_000);
  assert.equal(WINDOWS_NATIVE_TIMING_PROBE_TIMEOUT_MS, 60_000);
  assert.ok(WINDOWS_INSPECTION_TIMEOUT_MS > 15_000);
  assert.equal(windowsInspectionTimeoutForElapsed(0), 30_000);
  assert.equal(windowsInspectionTimeoutForElapsed(29_999), 30_000);
  assert.equal(windowsInspectionTimeoutForElapsed(45_000), 15_000);
  assert.equal(windowsInspectionTimeoutForElapsed(59_999.9), 1);
  assert.throws(
    () => windowsInspectionTimeoutForElapsed(60_000),
    (error) => error instanceof WindowsNativeStageError && error.stage === "spawn:cumulative-timeout",
  );
});

test("Windows PowerShell boundary retains a derived minimal environment and no filesystem writes", () => {
  assert.deepEqual(windowsPowerShellEnvironment("C:\\Windows"), {
    SystemRoot: "C:\\Windows",
    WINDIR: "C:\\Windows",
  });
  assert.throws(() => windowsPowerShellEnvironment("relative\\Windows"), WindowsNativeStageError);
  for (const forbidden of [
    "PATH", "PATHEXT", "PSModulePath", "TEMP", "TMP", "USERPROFILE", "HOMEDRIVE", "HOMEPATH",
  ]) assert.equal(forbidden in windowsPowerShellEnvironment("C:\\Windows"), false);
  assert.equal(WINDOWS_INSPECTOR_CREATES_CHILD_PROCESSES, false);
  assert.equal(WINDOWS_INSPECTOR_WRITES_FILESYSTEM, false);
  assert.equal(WINDOWS_INSPECTOR_TRANSPORT, "inherited-standard-handle");
  for (const source of [WINDOWS_INSPECTION_SOURCE, WINDOWS_NATIVE_TIMING_PROBE_SOURCE]) {
    assert.doesNotMatch(source, /Add-Type|Start-Process|Set-Content|Out-File|New-Item|Remove-Item|Invoke-Expression/i);
  }
});

test("Windows timing probe isolates baseline, Reflection.Emit, Win32, and standard-handle identity", () => {
  const milestones = [
    "Write-ProprMilestone 'entry-ps51-desktop-x64'",
    "Write-ProprMilestone 'constant-json'",
    "Write-ProprMilestone 'reflection-emit'",
    "Write-ProprMilestone 'harmless-win32'",
    "Write-ProprMilestone 'standard-handle-identity'",
  ].map((token) => WINDOWS_NATIVE_TIMING_PROBE_SOURCE.indexOf(token));
  assert.ok(milestones.every((offset) => offset >= 0));
  assert.deepEqual([...milestones].sort((left, right) => left - right), milestones);
  assert.ok(milestones[1] < WINDOWS_NATIVE_TIMING_PROBE_SOURCE.indexOf("DefineDynamicAssembly"));
  assert.ok(milestones[2] < WINDOWS_NATIVE_TIMING_PROBE_SOURCE.indexOf("::GetCurrentProcessId()"));
  assert.ok(milestones[3] < WINDOWS_NATIVE_TIMING_PROBE_SOURCE.indexOf("::GetStdHandle(-10)"));
  assert.ok(WINDOWS_NATIVE_TIMING_PROBE_SOURCE.indexOf("::GetFileInformationByHandle") < milestones[4]);
});

test("Windows batch results remain bound to descriptor index, kind, identity, and user", async () => {
  const directory = mkdtempSync(join(tmpdir(), "propr-windows-authority-test-"));
  const firstPath = join(directory, "first");
  const secondPath = join(directory, "second");
  writeFileSync(firstPath, "a");
  writeFileSync(secondPath, "b");
  const firstFd = openSync(firstPath, "r");
  const secondFd = openSync(secondPath, "r");
  const firstIdentity = stableAuthorityIdentity(firstFd);
  const secondIdentity = stableAuthorityIdentity(secondFd);
  const entries = [
    { path: firstPath, kind: "env" as const, pinnedFd: firstFd },
    { path: secondPath, kind: "env" as const, pinnedFd: secondFd },
  ];
  const validEntries = [firstIdentity, secondIdentity].map((identity, index) => inspection({
    index,
    kind: "file",
    authorityKind: "env",
    volumeSerialNumber: identity.device,
    verifiedVolumeSerialNumber: identity.device,
    fileId: identity.file,
    verifiedFileId: identity.file,
  }));
  const inspector = (results: readonly WindowsAuthorityInspection[]): ConnectRootAuthorityInspector => ({
    inspectDarwinAcl: () => { throw new Error("unused"); },
    inspectWindowsAcl: async () => { throw new Error("unused"); },
    inspectWindowsAcls: async () => results,
  });
  try {
    await assertNativeWindowsEntriesAuthority(inspector(validEntries), entries);
    for (const bad of [
      [{ ...validEntries[0], index: 1 }, validEntries[1]],
      [{ ...validEntries[0], kind: "directory" as const }, validEntries[1]],
      [{ ...validEntries[0], authorityKind: "data" as const }, validEntries[1]],
      [{ ...validEntries[0], fileId: (BigInt(validEntries[0].fileId) + 1n).toString() }, validEntries[1]],
      [validEntries[0], { ...validEntries[1], currentUserSid: "S-1-5-21-9" }],
    ]) {
      await assert.rejects(
        assertNativeWindowsEntriesAuthority(inspector(bad), entries),
        WindowsAuthorityInspectionError,
      );
    }
  } finally {
    closeSync(firstFd);
    closeSync(secondFd);
    rmSync(directory, { recursive: true, force: true });
  }
});
