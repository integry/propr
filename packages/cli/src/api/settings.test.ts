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

test('unattended agent run limits parse and validate like the server', async () => {
  const { parseSettingValue, isValidSettingKey } = await import('./settings.js');
  for (const key of ['agent_run_usage_pause_percent', 'unattended_max_concurrent', 'unattended_window']) {
    assert.equal(isValidSettingKey(key), true, key);
  }
  assert.equal(isValidSettingKey('unattended_window_error'), false);
  assert.equal(parseSettingValue('agent_run_usage_pause_percent', '80%'), 80);
  assert.throws(() => parseSettingValue('agent_run_usage_pause_percent', '40'), /50 to 100/);
  assert.equal(parseSettingValue('unattended_max_concurrent', '2'), 2);
  assert.throws(() => parseSettingValue('unattended_max_concurrent', '0'), /1 to 100/);
  assert.equal(parseSettingValue('unattended_window', ' 02:00-07:00@Europe/Riga '), '02:00-07:00@Europe/Riga');
  assert.equal(parseSettingValue('unattended_window', 'none'), null);
  assert.throws(() => parseSettingValue('unattended_window', '2am-7am'), /HH:MM-HH:MM/);
});
