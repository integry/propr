import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  ApiError,
  ForbiddenError,
  UnauthorizedError,
} from "../api/errors.js";
import {
  classifyApiError,
  LOGIN_REQUIRED_ERROR,
  presentApiError,
} from "./apiErrorPresentation.js";

const originalConsoleError = console.error;

afterEach(() => {
  console.error = originalConsoleError;
});

test("classifies typed and legacy 401 failures as login-required", () => {
  const errors = [
    new Error("Unauthorized"),
    new Error("unauthorized"),
    new UnauthorizedError(),
    new Error("Request failed with status 401"),
    new Error("401 Unauthorized"),
    Object.assign(new Error("Authentication failed"), { status: 401 }),
  ];

  for (const error of errors) {
    assert.equal(classifyApiError(error).kind, "unauthorized", error.message);
  }
});

test("keeps typed and plain 403 failures distinct from login-required failures", () => {
  const errors = [
    new ForbiddenError(),
    new Error("Forbidden"),
    new Error("HTTP 403"),
    new Error("status 403"),
    new Error("403 Forbidden"),
    Object.assign(new Error("Unauthorized access"), { status: 403 }),
  ];

  for (const error of errors) {
    assert.equal(classifyApiError(error).kind, "forbidden", error.message);
  }
});

test("prefers typed ApiError status over conflicting legacy message text", () => {
  assert.equal(
    classifyApiError(new ApiError("Forbidden", "UNKNOWN", 401)).kind,
    "unauthorized"
  );
  assert.equal(
    classifyApiError(new ApiError("Unauthorized", "UNKNOWN", 403)).kind,
    "forbidden"
  );
});

test("does not infer auth failures from standalone domain numbers", () => {
  assert.equal(classifyApiError(new Error("Task 401 not found")).kind, "other");
  assert.equal(classifyApiError(new Error("issue 403 is closed")).kind, "other");
});

test("treats every explicit non-auth status as authoritative", () => {
  const errors = [
    new ApiError("Unauthorized", "UNKNOWN", 400),
    new ApiError("Forbidden", "UNKNOWN", 404),
    { message: "Unauthorized", status: 400 },
    { message: "Forbidden", statusCode: 404 },
  ];

  for (const error of errors) {
    const classification = classifyApiError(error);
    assert.equal(classification.kind, "api", classification.message);
    assert.ok(
      classification.status === 400 || classification.status === 404
    );
  }
});

test("presents centralized login, forbidden, and fallback messages", () => {
  const lines: string[] = [];
  console.error = (...args: unknown[]) => lines.push(args.map(String).join(" "));

  presentApiError(new Error("Unauthorized"), {
    forbiddenMessage: "forbidden message",
    fallbackMessage: (message) => `fallback: ${message}`,
  });
  presentApiError(new ForbiddenError(), {
    forbiddenMessage: "forbidden message",
    fallbackMessage: "fallback",
  });
  presentApiError(new Error("broken"), {
    forbiddenMessage: "forbidden message",
    fallbackMessage: (message) => `fallback: ${message}`,
  });

  assert.deepEqual(lines, [LOGIN_REQUIRED_ERROR, "forbidden message", "fallback: broken"]);
});
