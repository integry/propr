import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  acquireInstalledWindowsLaunchLease,
  WindowsInstalledAuthorityError,
  type InstalledAuthorityIdentity,
  type WindowsInstalledAuthoritySession,
} from "./windowsInstalledAuthority.js";

const expected: InstalledAuthorityIdentity = {
  serviceVersion: "3.0.0",
  imagePath: String.raw`C:\Program Files\ProPR Connect Authority\ProPRConnectAuthority.exe`,
  volumeSerialNumber: "42",
  fileId: "340282366920938463463374607431768211",
  sha256: "a".repeat(64),
  authenticodeLeafSha256: "b".repeat(64),
  authenticodeSpkiSha256: "c".repeat(64),
};
const artifact = { path: String.raw`C:\mutable-npm\connect-authority-broker.exe`, sha256: "d".repeat(64) };
const canonical = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
};

class Session implements WindowsInstalledAuthoritySession {
  calls = 0;
  closed = false;
  mutate?: (receipt: Record<string, unknown>) => void;
  failAt = 0;
  async exchange(document: unknown): Promise<unknown> {
    this.calls += 1;
    if (this.failAt === this.calls) throw new WindowsInstalledAuthorityError("AUTHORITY");
    const request = document as Record<string, unknown>;
    if (request.kind === "authorize-launch") {
      const receipt: Record<string, unknown> = {
        version: 3, kind: "launch-authorized", requestId: request.requestId, nonce: request.nonce,
        requestDigest: createHash("sha256").update(canonical(request)).digest("hex"),
        hook: "windows-service.before-package-createprocess-v1", leaseId: "e".repeat(32),
        serviceVersion: "3.0.0", serverPid: "123", pipeServerPid: "123",
        imagePath: expected.imagePath, volumeSerialNumber: expected.volumeSerialNumber, fileId: expected.fileId,
        sha256: expected.sha256, authenticodeLeafSha256: expected.authenticodeLeafSha256,
        authenticodeSpkiSha256: expected.authenticodeSpkiSha256, accountSid: "S-1-5-18",
        daclProtected: true, replayed: false,
      };
      this.mutate?.(receipt);
      return receipt;
    }
    return {
      version: 3, kind: `${request.kind}-receipt`, requestId: request.requestId, nonce: request.nonce,
      leaseId: request.leaseId, verified: true,
    };
  }
  close(): void { this.closed = true; }
}

test("installed service authenticates the exact first launch boundary", async () => {
  const session = new Session();
  let maliciousOldBrokerMarker = false;
  const lease = await acquireInstalledWindowsLaunchLease(artifact, expected, {
    session, nonce: "1".repeat(64), requestId: "2".repeat(32),
  });
  assert.equal(maliciousOldBrokerMarker, false, "the old package path executed before service authorization");
  await lease.confirm(456);
  assert.equal(maliciousOldBrokerMarker, false);
  await lease.release();
  assert.equal(session.calls, 3);
  assert.equal(session.closed, true);
});

for (const [name, mutate] of [
  ["same-user replace", (value: Record<string, unknown>) => { value.fileId = "9"; }],
  ["same-user write", (value: Record<string, unknown>) => { value.sha256 = "0".repeat(64); }],
  ["same-user delete", (value: Record<string, unknown>) => { value.imagePath = String.raw`C:\Temp\missing.exe`; }],
  ["same-user rename", (value: Record<string, unknown>) => { value.volumeSerialNumber = "43"; }],
  ["pipe spoof", (value: Record<string, unknown>) => { value.pipeServerPid = "999"; }],
  ["stale service version", (value: Record<string, unknown>) => { value.serviceVersion = "2.9.0"; }],
  ["unauthorized user or session", (value: Record<string, unknown>) => { value.accountSid = "S-1-5-21-1"; }],
  ["request replay", (value: Record<string, unknown>) => { value.replayed = true; }],
  ["wrong request nonce", (value: Record<string, unknown>) => { value.nonce = "f".repeat(64); }],
] as const) {
  test(`installed authority rejects ${name}`, async () => {
    const session = new Session();
    session.mutate = mutate;
    await assert.rejects(acquireInstalledWindowsLaunchLease(artifact, expected, {
      session, nonce: "1".repeat(64), requestId: "2".repeat(32),
    }), WindowsInstalledAuthorityError);
    assert.equal(session.closed, true);
  });
}

test("oversized and invalid launch frames are rejected before the pipe", async () => {
  const session = new Session();
  await assert.rejects(acquireInstalledWindowsLaunchLease({ ...artifact, path: `C:\\${"x".repeat(2000)}` }, expected,
    { session }), (error: unknown) => error instanceof WindowsInstalledAuthorityError && error.code === "PROTOCOL");
  assert.equal(session.calls, 0);
  session.mutate = (value) => { value.extra = true; };
  await assert.rejects(acquireInstalledWindowsLaunchLease(artifact, expected, { session }), WindowsInstalledAuthorityError);
});

test("service stop, crash, timeout, and uninstall during a request cannot authorize execution", async () => {
  for (const failAt of [1, 2, 3]) {
    const session = new Session();
    session.failAt = failAt;
    if (failAt === 1) {
      await assert.rejects(acquireInstalledWindowsLaunchLease(artifact, expected, { session }), WindowsInstalledAuthorityError);
      continue;
    }
    const lease = await acquireInstalledWindowsLaunchLease(artifact, expected, { session });
    if (failAt === 2) await assert.rejects(lease.confirm(456), WindowsInstalledAuthorityError);
    else {
      await lease.confirm(456);
      await assert.rejects(lease.release(), WindowsInstalledAuthorityError);
    }
  }
});
