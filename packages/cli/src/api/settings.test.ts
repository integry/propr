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

test('dashboard_summary_enabled accepts booleans only', async () => {
  const { parseSettingValue, VALID_SETTING_KEYS } = await import('./settings.js');
  assert.ok(VALID_SETTING_KEYS.includes('dashboard_summary_enabled'));
  assert.equal(parseSettingValue('dashboard_summary_enabled', 'false'), false);
  assert.equal(parseSettingValue('dashboard_summary_enabled', 'true'), true);
  assert.throws(() => parseSettingValue('dashboard_summary_enabled', 'yes'), /true.*false/);
});

test('followup_requires_assignment accepts booleans only', async () => {
  const { parseSettingValue, VALID_SETTING_KEYS } = await import('./settings.js');
  assert.ok(VALID_SETTING_KEYS.includes('followup_requires_assignment'));
  assert.equal(parseSettingValue('followup_requires_assignment', 'true'), true);
  assert.equal(parseSettingValue('followup_requires_assignment', 'FALSE'), false);
  for (const value of ['1', '0', 'yes', '']) {
    assert.throws(() => parseSettingValue('followup_requires_assignment', value), /followup_requires_assignment: must be "true" or "false"/);
  }
});

test('legacy threshold and response deprecation metadata are not writable CLI setting keys', async () => {
  const { isValidSettingKey } = await import('./settings.js');
  assert.equal(isValidSettingKey('auto_followup_score_threshold'), false);
  assert.equal(isValidSettingKey('deprecated_settings'), false);
});
