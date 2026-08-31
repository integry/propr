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
  WINDOWS_NATIVE_STAGE_CODES,
  WINDOWS_UINT64_COMPOSER_SOURCE,
  WINDOWS_UNSIGNED_FIELD_DECODER_SOURCE,
  windowsBrokerFailureStage,
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
  const stageFailure = (document: string, stage: string): void => assert.throws(
    () => parseWindowsInspectionDocument(document),
    (error) => error instanceof WindowsNativeStageError && error.stage === stage,
  );
  stageFailure("{", "parent:json-parse");
  stageFailure(`${valid}\n`, "parent:json-canonical");
  stageFailure(`{"version":1,"version":1,"entries":[]}`, "parent:json-canonical");
  for (const malformed of [
    "[]",
    JSON.stringify({ version: 1, entries: [], extra: true }),
    JSON.stringify({ version: 2, entries: [] }),
    JSON.stringify({ version: 1, entries: {} }),
    JSON.stringify({ version: 1, entries: Array.from({ length: 33 }, () => inspection()) }),
  ]) stageFailure(malformed, "parent:document-shape");
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

test("Windows production isolates entry fields and retains private handle lifetime", () => {
  assert.ok(WINDOWS_NATIVE_STAGE_CODES.includes("broker:fd-duplicate"));
  assert.ok(WINDOWS_NATIVE_STAGE_CODES.includes("broker:index-info-initial"));
  assert.ok(WINDOWS_NATIVE_STAGE_CODES.includes("broker:current-user-sid"));
  assert.ok(WINDOWS_NATIVE_STAGE_CODES.includes("broker:index-info-revalidation"));
  assert.ok(WINDOWS_NATIVE_STAGE_CODES.includes("broker:index-info-decode"));
  assert.ok(WINDOWS_NATIVE_STAGE_CODES.includes("broker:index-info-compose"));
  assert.ok(WINDOWS_NATIVE_STAGE_CODES.includes("broker:entry-format"));
  assert.ok(WINDOWS_NATIVE_STAGE_CODES.includes("broker:entry-flags"));
  assert.ok(WINDOWS_NATIVE_STAGE_CODES.includes("broker:entry-rules"));
  assert.ok(WINDOWS_NATIVE_STAGE_CODES.includes("broker:entry-build"));
  assert.equal((WINDOWS_NATIVE_STAGE_CODES as readonly string[]).includes("broker:index-info"), false);
  assert.equal(windowsBrokerFailureStage(79), "broker:index-info-revalidation");
  assert.equal(windowsBrokerFailureStage(81), "broker:index-info-decode");
  assert.equal(windowsBrokerFailureStage(82), "broker:index-info-compose");
  assert.equal(windowsBrokerFailureStage(83), "broker:entry-build");
  assert.equal(windowsBrokerFailureStage(84), "broker:entry-format");
  assert.equal(windowsBrokerFailureStage(85), "broker:entry-flags");
  assert.equal(windowsBrokerFailureStage(86), "broker:entry-rules");

  const duplicate = WINDOWS_INSPECTION_SOURCE.indexOf("$stage=80");
  const initial = WINDOWS_INSPECTION_SOURCE.indexOf("$stage=74");
  const sid = WINDOWS_INSPECTION_SOURCE.indexOf("$stage=78");
  const revalidation = WINDOWS_INSPECTION_SOURCE.indexOf("$stage=79");
  const decode = WINDOWS_INSPECTION_SOURCE.indexOf("$stage=81", revalidation);
  const compose = WINDOWS_INSPECTION_SOURCE.indexOf("$stage=82", decode);
  const entryFormat = WINDOWS_INSPECTION_SOURCE.indexOf("$stage=84", compose);
  const entryFlags = WINDOWS_INSPECTION_SOURCE.indexOf("$stage=85", entryFormat);
  const entryRules = WINDOWS_INSPECTION_SOURCE.indexOf("$stage=86", entryFlags);
  const entryBuild = WINDOWS_INSPECTION_SOURCE.indexOf("$stage=83", entryRules);
  const json = WINDOWS_INSPECTION_SOURCE.indexOf("$stage=77", entryBuild);
  assert.ok(duplicate >= 0 && duplicate < initial && initial < sid && sid < revalidation
    && revalidation < decode && decode < compose && compose < entryFormat
    && entryFormat < entryFlags && entryFlags < entryRules && entryRules < entryBuild
    && entryBuild < json);
  assert.match(WINDOWS_INSPECTION_SOURCE.slice(duplicate, initial),
    /DuplicateHandle\(\s*\[ProprReadOnlyAuthority\]::GetCurrentProcess\(\),\$originalHandle,\s*\[ProprReadOnlyAuthority\]::GetCurrentProcess\(\),\[ref\]\$privateHandle,0,\$false,2\)\)\{exit \$stage\}/);
  assert.match(WINDOWS_INSPECTION_SOURCE.slice(initial, sid),
    /^\$stage=74\n  \$before=.*AllocHGlobal\(52\)\n  if\(-not .*GetFileInformationByHandle\(\$privateHandle,\$before\)\)\{exit \$stage\}\n  $/s);
  assert.match(WINDOWS_INSPECTION_SOURCE.slice(sid, WINDOWS_INSPECTION_SOURCE.indexOf("$stage=75", sid)),
    /^\$stage=78\n  \$current=.*WindowsIdentity\]::GetCurrent\(\)\.User\n  if\(\$null-eq \$current\)\{exit \$stage\}\n  \$currentSid=\$current\.Value\n  $/s);
  assert.match(WINDOWS_INSPECTION_SOURCE.slice(revalidation, decode),
    /^\$stage=79\n  \$after=.*AllocHGlobal\(52\)\n  if\(-not .*GetFileInformationByHandle\(\$privateHandle,\$after\)\)\{exit \$stage\}\n  $/s);
  const decodedIdentity = WINDOWS_INSPECTION_SOURCE.slice(decode, compose);
  assert.match(decodedIdentity, /^\$stage=81\n  \$beforeVolume=/);
  for (const [field, structure, offset] of [
    ["beforeVolume", "before", 28], ["afterVolume", "after", 28],
    ["beforeHigh", "before", 44], ["beforeLow", "before", 48],
    ["afterHigh", "after", 44], ["afterLow", "after", 48],
  ] as const) {
    assert.match(decodedIdentity, new RegExp(`\\$${field}=Read-ProprUInt32 \\$${structure} ${offset}`));
  }
  assert.equal(WINDOWS_INSPECTION_SOURCE.match(/function Read-ProprUInt32/g)?.length, 1);
  assert.equal(WINDOWS_INSPECTION_SOURCE.match(/Read-ProprUInt32 \$(?:before|after) (?:28|44|48)/g)?.length, 6);
  assert.match(decodedIdentity,
    /\$afterHigh=Read-ProprUInt32 \$after 44;\$afterLow=Read-ProprUInt32 \$after 48\n  $/);
  assert.doesNotMatch(WINDOWS_INSPECTION_SOURCE,
    /\[uint32\]\[Runtime\.InteropServices\.Marshal\]::ReadInt32/);
  assert.match(WINDOWS_UNSIGNED_FIELD_DECODER_SOURCE,
    /if\(-not \[BitConverter\]::IsLittleEndian\)\{exit \$stage\}\n  \$signed=\[int32\]\[Runtime\.InteropServices\.Marshal\]::ReadInt32\(\$pointer,\$offset\)\n  \$bytes=\[BitConverter\]::GetBytes\(\$signed\)\n  \[BitConverter\]::ToUInt32\(\$bytes,0\)/);
  const composedIdentity = WINDOWS_INSPECTION_SOURCE.slice(
    compose, entryFormat,
  );
  assert.match(composedIdentity,
    /^\$stage=82\n  \$beforeId=Join-ProprUInt64 \$beforeLow \$beforeHigh\n  if\(\$beforeId-isnot \[uint64\]\)\{exit \$stage\}\n  \$afterId=Join-ProprUInt64 \$afterLow \$afterHigh\n  if\(\$afterId-isnot \[uint64\]\)\{exit \$stage\}\n  $/);
  const formattedIdentity = WINDOWS_INSPECTION_SOURCE.slice(entryFormat, entryFlags);
  assert.equal(formattedIdentity, [
    "$stage=84",
    "  $beforeVolumeDecimal=$beforeVolume.ToString([Globalization.CultureInfo]::InvariantCulture)",
    "  $afterVolumeDecimal=$afterVolume.ToString([Globalization.CultureInfo]::InvariantCulture)",
    "  $beforeIdDecimal=$beforeId.ToString([Globalization.CultureInfo]::InvariantCulture)",
    "  $afterIdDecimal=$afterId.ToString([Globalization.CultureInfo]::InvariantCulture)",
    "  if($beforeVolumeDecimal-isnot [string]-or $beforeVolumeDecimal.Length-eq 0-or $beforeVolumeDecimal.Length-gt 10-or $beforeVolumeDecimal-cnotmatch '^(0|[1-9][0-9]*)$'){exit $stage}",
    "  if($afterVolumeDecimal-isnot [string]-or $afterVolumeDecimal.Length-eq 0-or $afterVolumeDecimal.Length-gt 10-or $afterVolumeDecimal-cnotmatch '^(0|[1-9][0-9]*)$'){exit $stage}",
    "  if($beforeIdDecimal-isnot [string]-or $beforeIdDecimal.Length-eq 0-or $beforeIdDecimal.Length-gt 20-or $beforeIdDecimal-cnotmatch '^(0|[1-9][0-9]*)$'){exit $stage}",
    "  if($afterIdDecimal-isnot [string]-or $afterIdDecimal.Length-eq 0-or $afterIdDecimal.Length-gt 20-or $afterIdDecimal-cnotmatch '^(0|[1-9][0-9]*)$'){exit $stage}",
    "  ",
  ].join("\n"));
  assert.equal(formattedIdentity.match(/\.ToString\(\[Globalization\.CultureInfo\]::InvariantCulture\)/g)?.length, 4);
  assert.doesNotMatch(formattedIdentity, /\$entry=|Console|Write-|Out\./);
  const entryFlagValidation = WINDOWS_INSPECTION_SOURCE.slice(entryFlags, entryRules);
  assert.equal(entryFlagValidation, [
    "$stage=85",
    "  $daclProtected=[bool](($control-band 0x1000)-ne 0)",
    "  $reparsePoint=[bool](([Runtime.InteropServices.Marshal]::ReadInt32($before,0)-band 0x400)-ne 0)",
    "  if($daclProtected-isnot [bool]-or $reparsePoint-isnot [bool]){exit $stage}",
    "  ",
  ].join("\n"));
  assert.doesNotMatch(entryFlagValidation, /Console|Write-|Out\./);
  const entryRuleValidation = WINDOWS_INSPECTION_SOURCE.slice(entryRules, entryBuild);
  assert.equal(entryRuleValidation, [
    "$stage=86",
    "  [object[]]$rulesArray=$rules.ToArray()",
    "  if($rulesArray-isnot [object[]]-or $rulesArray.Count-ne $rules.Count-or $rulesArray.Count-gt 128){exit $stage}",
    "  for($ruleIndex=0;$ruleIndex-lt $rulesArray.Count;$ruleIndex++){",
    "    if(-not [object]::ReferenceEquals($rulesArray[$ruleIndex],$rules[$ruleIndex])){exit $stage}",
    "  }",
    "  ",
  ].join("\n"));
  assert.equal(WINDOWS_INSPECTION_SOURCE.match(/\[object\[\]\]\$rulesArray=\$rules\.ToArray\(\)/g)?.length, 1);
  assert.doesNotMatch(WINDOWS_INSPECTION_SOURCE, /@\(\s*\$rules\s*\)/);
  assert.doesNotMatch(entryRuleValidation, /ConvertTo-Json|\.ToString|Console|Write-|Out\./);
  const entryConstruction = WINDOWS_INSPECTION_SOURCE.slice(entryBuild, json);
  assert.equal(entryConstruction, [
    "$stage=83",
    "  $entry=[pscustomobject][ordered]@{",
    "    index=__PROPR_INDEX__;kind='__PROPR_ENTRY_KIND__';authorityKind='__PROPR_AUTHORITY_KIND__';currentUserSid=$currentSid;ownerSid=$ownerSid",
    "    daclProtected=$daclProtected;reparsePoint=$reparsePoint",
    "    volumeSerialNumber=$beforeVolumeDecimal",
    "    fileId=$beforeIdDecimal",
    "    verifiedVolumeSerialNumber=$afterVolumeDecimal",
    "    verifiedFileId=$afterIdDecimal;rules=$rulesArray",
    "  }",
    "  ",
  ].join("\n"));
  assert.doesNotMatch(entryConstruction,
    /Marshal|\.ToString|InvariantCulture|@\(\$rules\)|ReferenceEquals|-band|\bfor\s*\(/);
  assert.doesNotMatch(composedIdentity, /ToString|\$entry=/);
  assert.doesNotMatch(WINDOWS_INSPECTION_SOURCE, /4294967296|\[uint64\]\$(?:before|after)High\*/);
  assert.match(WINDOWS_UINT64_COMPOSER_SOURCE,
    /function Join-ProprUInt64\(\[uint32\]\$low,\[uint32\]\$high\)\{\n  if\(-not \[BitConverter\]::IsLittleEndian\)\{exit \$stage\}\n  \$bytes=New-Object byte\[\] 8\n  \[Array\]::Copy\(\[BitConverter\]::GetBytes\(\[uint32\]\$low\),0,\$bytes,0,4\)\n  \[Array\]::Copy\(\[BitConverter\]::GetBytes\(\[uint32\]\$high\),0,\$bytes,4,4\)\n  \[BitConverter\]::ToUInt64\(\$bytes,0\)\n\}/);
  const unsignedDecimal = (value: number): string => {
    const bytes = Buffer.alloc(4);
    bytes.writeInt32LE(value, 0);
    return bytes.readUInt32LE(0).toString(10);
  };
  const highBit = unsignedDecimal(-2_147_483_648);
  const allBits = unsignedDecimal(-1);
  assert.equal(highBit, "2147483648");
  assert.equal(allBits, "4294967295");
  const composedDecimal = (low: number, high: number): string => {
    const bytes = Buffer.alloc(8);
    bytes.writeUInt32LE(low, 0);
    bytes.writeUInt32LE(high, 4);
    return bytes.readBigUInt64LE(0).toString(10);
  };
  const highBitFileId = composedDecimal(Number(allBits), Number(highBit));
  const allBitsFileId = composedDecimal(Number(allBits), Number(allBits));
  assert.equal(highBitFileId, "9223372041149743103");
  assert.equal(allBitsFileId, "18446744073709551615");
  assert.match(JSON.stringify({ highBit, allBits, highBitFileId, allBitsFileId }),
    /^\{"highBit":"\d+","allBits":"\d+","highBitFileId":"\d+","allBitsFileId":"\d+"\}$/);
  assert.match(WINDOWS_INSPECTION_SOURCE,
    /GetSecurityInfo\(\$privateHandle,1,5,\[ref\]\$owner,\[ref\]\$group,\[ref\]\$dacl,\[ref\]\$sacl,\[ref\]\$descriptor\)/);
  assert.equal(WINDOWS_INSPECTION_SOURCE.match(/::CloseHandle\(\$privateHandle\)/g)?.length, 1);
  assert.match(WINDOWS_INSPECTION_SOURCE,
    /finally \{if\(\$privateHandleOwned\)\{\$null=\[ProprReadOnlyAuthority\]::CloseHandle\(\$privateHandle\)\}\}/);
  assert.doesNotMatch(WINDOWS_INSPECTION_SOURCE, /CloseHandle\(\$originalHandle\)/);
  assert.doesNotMatch(WINDOWS_INSPECTION_SOURCE.slice(initial), /\$originalHandle/);
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
  const populated = WINDOWS_NATIVE_TIMING_PROBE_SOURCE.indexOf("GetFileInformationByHandle($handle,$info)");
  const probeDecode = WINDOWS_NATIVE_TIMING_PROBE_SOURCE.indexOf("Read-ProprUInt32 $info", populated);
  const probeCompose = WINDOWS_NATIVE_TIMING_PROBE_SOURCE.indexOf(
    "Join-ProprUInt64 $probeLow $probeHigh", probeDecode,
  );
  const probeFormat = WINDOWS_NATIVE_TIMING_PROBE_SOURCE.indexOf("$probeVolumeDecimal=", probeCompose);
  assert.ok(populated >= 0 && populated < probeDecode && probeDecode < probeCompose
    && probeCompose < probeFormat && probeFormat < milestones[4]);
  assert.equal(WINDOWS_NATIVE_TIMING_PROBE_SOURCE.match(/function Read-ProprUInt32/g)?.length, 1);
  assert.equal(WINDOWS_NATIVE_TIMING_PROBE_SOURCE.match(/Read-ProprUInt32 \$info (?:28|44|48)/g)?.length, 3);
  assert.match(WINDOWS_NATIVE_TIMING_PROBE_SOURCE.slice(probeCompose, probeFormat),
    /^Join-ProprUInt64 \$probeLow \$probeHigh\n  if\(\$probeId-isnot \[uint64\]\)\{exit \$stage\}\n  $/);
  assert.equal(WINDOWS_NATIVE_TIMING_PROBE_SOURCE.slice(probeFormat, milestones[4]), [
    "$probeVolumeDecimal=$probeVolume.ToString([Globalization.CultureInfo]::InvariantCulture)",
    "  $probeIdDecimal=$probeId.ToString([Globalization.CultureInfo]::InvariantCulture)",
    "  if($probeVolumeDecimal-isnot [string]-or $probeVolumeDecimal.Length-eq 0-or $probeVolumeDecimal.Length-gt 10-or $probeVolumeDecimal-cnotmatch '^(0|[1-9][0-9]*)$'){exit $stage}",
    "  if($probeIdDecimal-isnot [string]-or $probeIdDecimal.Length-eq 0-or $probeIdDecimal.Length-gt 20-or $probeIdDecimal-cnotmatch '^(0|[1-9][0-9]*)$'){exit $stage}",
    "  ",
  ].join("\n"));
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
  const diagnosticSymbol = Symbol.for("propr.test.windowsNativeDiagnostic");
  const globals = globalThis as Record<symbol, unknown>;
  const originalDiagnostic = globals[diagnosticSymbol];
  const diagnosticStages: string[] = [];
  globals[diagnosticSymbol] = (stage: string): void => { diagnosticStages.push(stage); };
  try {
    await assertNativeWindowsEntriesAuthority(inspector(validEntries), entries);
    const noEntries = parseWindowsInspectionDocument('{"version":1,"entries":[]}');
    await assert.rejects(
      assertNativeWindowsEntriesAuthority(inspector(noEntries), entries),
      WindowsAuthorityInspectionError,
    );
    assert.equal(diagnosticStages.pop(), "parent:entry-count");
    const malformedEntries = parseWindowsInspectionDocument('{"version":1,"entries":[{},{}]}');
    await assert.rejects(
      assertNativeWindowsEntriesAuthority(
        inspector(malformedEntries as readonly WindowsAuthorityInspection[]), entries,
      ),
      WindowsAuthorityInspectionError,
    );
    assert.equal(diagnosticStages.pop(), "parent:entry-shape");
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
    if (originalDiagnostic === undefined) delete globals[diagnosticSymbol];
    else globals[diagnosticSymbol] = originalDiagnostic;
    closeSync(firstFd);
    closeSync(secondFd);
    rmSync(directory, { recursive: true, force: true });
  }
});
