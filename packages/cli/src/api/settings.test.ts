import assert from "node:assert/strict";
import { test } from "node:test";
import { triggerSummarizationReindexAll } from "./settings.js";
import type { ApiClient } from "./client.js";

test("triggerSummarizationReindexAll posts ignoreCooldown body", async () => {
  const calls: Array<{ endpoint: string; options?: unknown }> = [];
  const client = {
    async post(endpoint: string, options?: unknown) {
      calls.push({ endpoint, options });
      return {
        data: {
          success: true,
          repositoriesQueued: 1,
          repositoriesSkippedCooldown: 0,
          repositoriesSkippedAlreadyQueued: 0,
          repositoriesFailedClone: 0,
          ignoreCooldown: true,
        },
        status: 200,
        headers: new Headers(),
      };
    },
  } as unknown as ApiClient;

  await triggerSummarizationReindexAll(true, client);

  assert.deepEqual(calls, [{
    endpoint: "/api/config/summarization/reindex-all",
    options: { body: { ignoreCooldown: true } },
  }]);
});
