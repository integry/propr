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

test('legacy threshold and response deprecation metadata are not writable CLI setting keys', async () => {
  const { isValidSettingKey } = await import('./settings.js');
  assert.equal(isValidSettingKey('auto_followup_score_threshold'), false);
  assert.equal(isValidSettingKey('deprecated_settings'), false);
});

test('unattended admission settings are writable CLI keys with client-side bounds', async () => {
  const { parseSettingValue, isValidSettingKey } = await import('./settings.js');
  assert.equal(isValidSettingKey('unattended_max_concurrent'), true);
  assert.equal(isValidSettingKey('unattended_window'), true);
  assert.equal(isValidSettingKey('unattended_window_error'), false);

  assert.equal(parseSettingValue('unattended_max_concurrent', '2'), 2);
  assert.equal(parseSettingValue('unattended_max_concurrent', '0'), 0);
  assert.equal(parseSettingValue('unattended_max_concurrent', '100'), 100);
  for (const value of ['101', '-1', '1.5', 'two', '']) {
    assert.throws(() => parseSettingValue('unattended_max_concurrent', value), /0 \(pause unattended work\) to 100/);
  }

  assert.equal(parseSettingValue('unattended_window', ' 02:00-07:00@Europe/Riga '), '02:00-07:00@Europe/Riga');
  assert.equal(parseSettingValue('unattended_window', ''), '');
  assert.equal(parseSettingValue('unattended_window', 'none'), '');
  assert.throws(() => parseSettingValue('unattended_window', '02:00-07:00'), /02:00-07:00@Europe\/Riga/);
});
