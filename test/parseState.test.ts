import assert from "node:assert/strict";
import test from "node:test";

import { parseOnOffState } from "../packages/cli/src/utils/parseState.js";

test("parseOnOffState trims surrounding whitespace", () => {
  assert.equal(parseOnOffState("on "), true);
  assert.equal(parseOnOffState(" off"), false);
});
