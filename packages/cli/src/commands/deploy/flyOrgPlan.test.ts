/**
 * Free-plan preflight. Run with:
 * `npx tsx --test src/commands/deploy/flyOrgPlan.test.ts` (from packages/cli).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { FlyMachinesApi } from "./flyMachinesApi.js";
import { assertVolumeFitsFlyPlan, exceedsFreePlanVolumeCap, fetchFlyOrgPlan } from "./flyOrgPlan.js";

function respond(status: number, body: unknown): typeof fetch {
  return (async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status })) as unknown as typeof fetch;
}

test("the org plan comes from organization.paidPlan; anything else is unknown", async () => {
  assert.equal(await fetchFlyOrgPlan("Bearer t", "personal", respond(200, { data: { organization: { paidPlan: false } } })), "free");
  assert.equal(await fetchFlyOrgPlan("Bearer t", "personal", respond(200, { data: { organization: { paidPlan: true } } })), "paid");
  assert.equal(await fetchFlyOrgPlan("Bearer t", "personal", respond(200, { data: { organization: null }, errors: [{ message: "not found" }] })), "unknown");
  assert.equal(await fetchFlyOrgPlan("Bearer t", "personal", respond(401, { errors: [{ message: "unauthorized" }] })), "unknown");
  assert.equal(await fetchFlyOrgPlan("Bearer t", "personal", respond(200, "not json")), "unknown");
  const offline = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
  assert.equal(await fetchFlyOrgPlan("Bearer t", "personal", offline), "unknown");
});

test("the Machines API client asks GraphQL with its own authorization header", async () => {
  let seen: { url: string; authorization: string } | undefined;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen = { url, authorization: (init.headers as Record<string, string>).Authorization };
    return new Response(JSON.stringify({ data: { organization: { paidPlan: false } } }), { status: 200 });
  }) as unknown as typeof fetch;
  assert.equal(await new FlyMachinesApi({ token: "tok", fetchImpl }).orgPlan("acme"), "free");
  assert.deepEqual(seen, { url: "https://api.fly.io/graphql", authorization: "Bearer tok" });
});

test("only a Free-plan org with a volume over 5 GB is refused", () => {
  assert.equal(exceedsFreePlanVolumeCap({ volumeSizeGb: 5 }), false);
  assert.equal(exceedsFreePlanVolumeCap({ volumeSizeGb: 6 }), true);
  assert.throws(
    () => assertVolumeFitsFlyPlan({ org: "personal", volumeSizeGb: 20 }, "free"),
    /org personal is on the Fly Free plan, which caps volumes at 5 GB, but --volume-size is 20 GB\. Nothing was created\. Rerun without --volume-size \(default: 1 GB/,
  );
  assert.doesNotThrow(() => assertVolumeFitsFlyPlan({ org: "personal", volumeSizeGb: 5 }, "free"));
  assert.doesNotThrow(() => assertVolumeFitsFlyPlan({ org: "personal", volumeSizeGb: 20 }, "paid"));
  assert.doesNotThrow(() => assertVolumeFitsFlyPlan({ org: "personal", volumeSizeGb: 20 }, "unknown"));
});
