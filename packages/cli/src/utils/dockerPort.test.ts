import assert from "node:assert/strict";
import { test } from "node:test";
import { dockerPublishedHostPort, localhostServiceUrl } from "./dockerPort.js";

test("extracts local ports from Docker publish bindings", () => {
  assert.equal(dockerPublishedHostPort("4000"), "4000");
  assert.equal(dockerPublishedHostPort("127.0.0.1:4000"), "4000");
  assert.equal(dockerPublishedHostPort("[::1]:5173"), "5173");
  assert.equal(localhostServiceUrl("127.0.0.1:4000"), "http://localhost:4000");
});

test("rejects malformed or out-of-range publish bindings", () => {
  assert.throws(() => dockerPublishedHostPort("localhost"), /invalid Docker published port/);
  assert.throws(() => dockerPublishedHostPort("127.0.0.1:70000"), /invalid Docker published port/);
});
