#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

if (process.platform !== "darwin") {
  process.stderr.write("Native Connect authority verification requires macOS.\n");
  process.exit(1);
}

const root = resolve(import.meta.dirname, "..");
const result = spawnSync(process.execPath, [
  "--import", "tsx", "--test", join(root, "test", "nativeConnectAuthority.test.ts"),
], {
  cwd: root,
  shell: false,
  windowsHide: true,
  encoding: "utf8",
  env: process.env,
  timeout: 30_000,
  maxBuffer: 2 * 1024 * 1024,
});

const stdout = result.stdout ?? "";
const stderr = result.stderr ?? "";
process.stdout.write(stdout);
process.stderr.write(stderr);

const tapValue = (name) => {
  const matches = [...stdout.matchAll(new RegExp(`^# ${name} (\\d+)$`, "gm"))];
  return matches.length === 0 ? undefined : Number(matches.at(-1)[1]);
};
const valid = result.status === 0
  && !result.error
  && !result.signal
  && tapValue("tests") === 6
  && tapValue("pass") === 6
  && tapValue("fail") === 0
  && tapValue("skipped") === 0;

if (!valid) {
  process.stderr.write("Native Darwin Connect authority proof was incomplete.\n");
  process.exit(1);
}
process.stdout.write("Native Darwin authority proof: tests=6 pass=6 fail=0 skipped=0\n");
