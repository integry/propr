import assert from "node:assert/strict";
import { test } from "node:test";
import { filterRemovedRuntimePackages } from "./runtimeCommands.js";

test("runtime package removal matches pinned specs and package base names", () => {
  assert.deepEqual(
    filterRemovedRuntimePackages(
      ["chromium=1.2+BuildA", "ffmpeg", "libgtk-3-0:amd64=3.24.38-2~Deb12u3"],
      ["Chromium", "libgtk-3-0"]
    ),
    ["ffmpeg"]
  );
});
