import assert from "node:assert/strict";
import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  assertNativeEntryAuthority,
  assertSafeDarwinAclOutput,
  nativeConnectRootAuthorityInspector,
  stableAuthorityIdentity,
  type ConnectRootAuthorityInspector,
} from "../packages/cli/src/connectRootAuthority.js";

const EMPTY_ACL = "!#acl 1\n";
const READ_ONLY_ACL = [
  "!#acl 1",
  "user:AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE:reader:501:allow:read,readattr,readsecurity",
  "",
].join("\n");

test("Darwin ACL contract accepts bounded empty and read-only documents", () => {
  assert.doesNotThrow(() => assertSafeDarwinAclOutput(""));
  assert.doesNotThrow(() => assertSafeDarwinAclOutput(EMPTY_ACL));
  assert.doesNotThrow(() => assertSafeDarwinAclOutput(READ_ONLY_ACL));
});

test("Darwin ACL contract rejects mutation grants", () => {
  const writable = [
    "!#acl 1",
    "group:AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE:writers:20:allow:read,write",
    "",
  ].join("\n");
  assert.throws(() => assertSafeDarwinAclOutput(writable), /unexpected write authority/);
});

test("Darwin ACL contract rejects malformed and oversized output", () => {
  for (const malformed of [
    "\n",
    "user supplied path",
    "!#acl 1 extra\n",
    "!#acl 2\n",
    "!#acl 1\nunknown\n",
    `${"x".repeat(25 * 1024)}\n`,
  ]) assert.throws(() => assertSafeDarwinAclOutput(malformed), /malformed/);
});

function withPinnedFile(run: (path: string, fd: number) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "propr-darwin-contract-"));
  const path = join(directory, "entry");
  writeFileSync(path, "fixture");
  const fd = openSync(path, "r");
  return run(path, fd).finally(() => {
    closeSync(fd);
    rmSync(directory, { recursive: true, force: true });
  });
}

test("Darwin authority binds an inspection to the held descriptor identity", async () => {
  await withPinnedFile(async (path, fd) => {
    const identity = stableAuthorityIdentity(fd);
    const inspector: ConnectRootAuthorityInspector = {
      inspectDarwinAcl: () => ({ version: 1, ...identity, acl: EMPTY_ACL }),
      inspectWindowsAcl: async () => { throw new Error("unused"); },
    };
    await assert.doesNotReject(assertNativeEntryAuthority(inspector, "darwin", path, "env", fd));
  });
});

test("Darwin authority rejects an inspection for another object", async () => {
  await withPinnedFile(async (path, fd) => {
    const inspector: ConnectRootAuthorityInspector = {
      inspectDarwinAcl: () => ({ version: 1, device: "0", file: "0", acl: EMPTY_ACL }),
      inspectWindowsAcl: async () => { throw new Error("unused"); },
    };
    await assert.rejects(
      assertNativeEntryAuthority(inspector, "darwin", path, "env", fd),
      /did not match the pinned object/,
    );
  });
});

test("packaged Darwin broker inspects an ordinary held file without path re-resolution", {
  skip: process.platform !== "darwin" ? "requires native Darwin ACL APIs" : false,
}, async () => {
  await withPinnedFile(async (path, fd) => {
    await assert.doesNotReject(assertNativeEntryAuthority(
      nativeConnectRootAuthorityInspector,
      "darwin",
      path,
      "env",
      fd,
    ));
  });
});
