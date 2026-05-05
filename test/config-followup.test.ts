import test from 'node:test';
import assert from 'node:assert/strict';

import { db } from '@propr/core';
import { withConfigLock, ConfigRouteError } from '../packages/api/routes/configHelpers.ts';
import { saveSettingsWithRollback } from '../packages/api/routes/configRoutesSettings.ts';
import { parseClaudeOutputToConversationResult } from '../packages/api/routes/liveDetailsCodexParser.ts';

test('withConfigLock preserves specific config operation failures', async () => {
  const redisClient = {
    set: async () => 'OK',
    eval: async () => 1
  } as never;

  const result = await withConfigLock(redisClient, 'config:test:lock', async () => {
    throw new ConfigRouteError(422, { error: 'specific failure', failed_key: 'agents' });
  });

  assert.equal(result.status, 422);
  assert.deepEqual(result.body, { error: 'specific failure', failed_key: 'agents' });
});

test('saveSettingsWithRollback returns a specific failure without partial-commit bookkeeping keys', async () => {
  const originalTransaction = db.transaction.bind(db);
  const testDb = db as typeof db & { transaction: typeof db.transaction };
  let committed = false;
  let rolledBack = false;
  const writes: string[] = [];

  const trx = Object.assign(
    ((table: string) => ({
      insert: (row: { key: string }) => ({
        onConflict: (_column: string) => ({
          merge: async () => {
            assert.equal(table, 'system_configs');
            writes.push(row.key);
            if (row.key === 'pr_review_model') {
              throw new Error('db write failed');
            }
          }
        })
      })
    })) as unknown as typeof db,
    {
      commit: async () => {
        committed = true;
      },
      rollback: async () => {
        rolledBack = true;
      }
    }
  );

  testDb.transaction = async () => trx as never;

  try {
    let published = 0;
    const result = await saveSettingsWithRollback({
      settings: {
        planner_context_model: 'gpt-5',
        pr_review_model: 'claude-sonnet-4-6'
      },
      publishConfigUpdate: async () => {
        published += 1;
      },
      configStore: {
        loadSettings: async () => ({ existing: true }),
        saveSettings: async () => true,
        saveConfig: async () => true,
        loadAutoFollowupScoreThreshold: async () => 4,
        saveAutoFollowupScoreThreshold: async () => true,
        loadAutoResolveMergeConflicts: async () => false,
        saveAutoResolveMergeConflicts: async () => true,
        loadPrReviewModel: async () => '',
        savePrReviewModel: async () => true,
        loadUltrafixRatingGoal: async () => 8,
        saveUltrafixRatingGoal: async () => true,
        loadUltrafixMaxCycles: async () => 5,
        saveUltrafixMaxCycles: async () => true,
        loadUltrafixPauseSeconds: async () => 0,
        saveUltrafixPauseSeconds: async () => true
      }
    });

    assert.equal(result.status, 500);
    assert.equal(result.body.error, 'Failed to save "pr_review_model". No settings were committed. Please retry or check system logs.');
    assert.equal('rolled_back' in result.body, false);
    assert.equal('committed' in result.body, false);
    assert.equal(published, 0);
    assert.equal(committed, false);
    assert.equal(rolledBack, true);
    assert.deepEqual(writes, ['settings', 'pr_review_model']);
  } finally {
    testDb.transaction = originalTransaction;
  }
});

test('Claude malformed-line warning cap resets for each parse', () => {
  const originalWarn = console.warn;
  let warnings = 0;
  console.warn = () => {
    warnings += 1;
  };

  try {
    const malformedTranscript = Array.from({ length: 6 }, () => 'not-json').join('\n');

    parseClaudeOutputToConversationResult(malformedTranscript);
    parseClaudeOutputToConversationResult(malformedTranscript);

    assert.equal(warnings, 10);
  } finally {
    console.warn = originalWarn;
  }
});
