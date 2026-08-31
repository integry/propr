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
  ]) assert.throws(() => parseWindowsInspectionDocument(malformed));
  assert.throws(() => parseWindowsInspectionDocument("x".repeat(128 * 1024 + 1)));
  assert.throws(() => assertWindowsInspectionShape({ ...inspection(), extra: true }));
  assert.throws(() => assertWindowsInspectionShape({ ...inspection(), rules: [
    { identitySid: USER, inherited: false, accessType: "audit", appliesToSelf: true, rights: "1" },
  ] }));
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
