import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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

test('goal_question_max_wait_ms accepts whole milliseconds of at least one minute', async () => {
  const { parseSettingValue, VALID_SETTING_KEYS } = await import('./settings.js');
  assert.ok(VALID_SETTING_KEYS.includes('goal_question_max_wait_ms'));
  assert.equal(parseSettingValue('goal_question_max_wait_ms', '86400000'), 86_400_000);
  assert.equal(parseSettingValue('goal_question_max_wait_ms', '60000'), 60_000);
  for (const value of ['59999', '-1', '1.5', 'one day', '']) {
    assert.throws(() => parseSettingValue('goal_question_max_wait_ms', value), /at least 60000/);
  }
});

test('legacy threshold and response deprecation metadata are not writable CLI setting keys', async () => {
  const { isValidSettingKey } = await import('./settings.js');
  assert.equal(isValidSettingKey('auto_followup_score_threshold'), false);
  assert.equal(isValidSettingKey('deprecated_settings'), false);
});

test('usage pause percent and unproductive-run threshold are readable and writable keys with the API ranges', async () => {
  const { isValidSettingKey, parseSettingValue } = await import('./settings.js');
  assert.equal(isValidSettingKey('agent_run_usage_pause_percent'), true);
  assert.equal(isValidSettingKey('automation_unproductive_run_threshold'), true);

  assert.equal(parseSettingValue('agent_run_usage_pause_percent', '50'), 50);
  assert.equal(parseSettingValue('agent_run_usage_pause_percent', '100'), 100);
  assert.equal(parseSettingValue('agent_run_usage_pause_percent', ' 80 '), 80);
  for (const value of ['49', '101', '80.5', '80%', 'eighty', '', '-90']) {
    assert.throws(() => parseSettingValue('agent_run_usage_pause_percent', value), /agent_run_usage_pause_percent: must be an integer from 50 to 100/);
  }

  assert.equal(parseSettingValue('automation_unproductive_run_threshold', '1'), 1);
  assert.equal(parseSettingValue('automation_unproductive_run_threshold', '50'), 50);
  for (const value of ['0', '51', '2.5', 'three', '']) {
    assert.throws(() => parseSettingValue('automation_unproductive_run_threshold', value), /automation_unproductive_run_threshold: must be an integer from 1 to 50/);
  }
});

test('every scalar setting the API saves is a CLI setting key', async () => {
  const { isValidSettingKey } = await import('./settings.js');
  const source = await readFile(new URL('../../../api/routes/configHelpers.ts', import.meta.url), 'utf8');
  const block = source.match(/SPECIALIZED_SETTING_NAMES = \[([\s\S]*?)\] as const/);
  assert.ok(block, 'SPECIALIZED_SETTING_NAMES is still declared in configHelpers.ts');
  const names = [...block[1].matchAll(/'([a-z0-9_]+)'/g)].map(match => match[1])
    .filter(name => name !== 'auto_followup_score_threshold');
  assert.ok(names.includes('agent_run_usage_pause_percent'));
  for (const name of names) assert.equal(isValidSettingKey(name), true, `${name} must be a CLI setting key`);
});
