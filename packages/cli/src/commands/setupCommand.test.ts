/**
 * `propr setup` renderer-selection tests. Run with:
 * `npx tsx --test src/commands/setupCommand.test.ts` (from packages/cli).
 *
 * These pin the pure decision that routes between the Ink wizard and the
 * sequential readline fallback, without spinning up a terminal or either UI.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { canRenderInkSetup } from "./setupCommand.js";

const rawTty = { isTTY: true, setRawMode() {} };

test("canRenderInkSetup: true only when both streams are raw-mode TTYs", () => {
  assert.equal(canRenderInkSetup(rawTty, { isTTY: true }), true);
});

test("canRenderInkSetup: false when stdin is not a TTY (piped/redirected/CI)", () => {
  assert.equal(canRenderInkSetup({ isTTY: false, setRawMode() {} }, { isTTY: true }), false);
});

test("canRenderInkSetup: false when stdout is not a TTY", () => {
  assert.equal(canRenderInkSetup(rawTty, { isTTY: false }), false);
});

test("canRenderInkSetup: false when stdin cannot enter raw mode", () => {
  // A TTY without setRawMode (some SSH/embedded terminals) falls back to the
  // sequential readline wizard rather than a broken keyboard-driven view.
  assert.equal(canRenderInkSetup({ isTTY: true }, { isTTY: true }), false);
});
