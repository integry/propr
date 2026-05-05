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
        handleSettingsSaveSideEffects: () => {},
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

test('saveSettingsWithRollback scrubs specialized keys from the general settings blob', async () => {
  const originalTransaction = db.transaction.bind(db);
  const testDb = db as typeof db & { transaction: typeof db.transaction };
  const writes = new Map<string, unknown>();

  const trx = Object.assign(
    ((table: string) => ({
      insert: (row: { key: string; value: string }) => ({
        onConflict: (_column: string) => ({
          merge: async () => {
            assert.equal(table, 'system_configs');
            writes.set(row.key, JSON.parse(row.value));
          }
        })
      })
    })) as unknown as typeof db,
    {
      commit: async () => {},
      rollback: async () => {}
    }
  );

  testDb.transaction = async () => trx as never;

  try {
    const result = await saveSettingsWithRollback({
      settings: {
        ultrafix_rating_goal: 8
      },
      publishConfigUpdate: async () => {},
      configStore: {
        loadSettings: async () => ({
          existing: true,
          pr_review_model: 'stale-model',
          ultrafix_rating_goal: 6,
        }),
        handleSettingsSaveSideEffects: () => {},
        saveSettings: async () => true,
        saveConfig: async () => true,
        loadAutoFollowupScoreThreshold: async () => 4,
        saveAutoFollowupScoreThreshold: async () => true,
        loadAutoResolveMergeConflicts: async () => false,
        saveAutoResolveMergeConflicts: async () => true,
        loadPrReviewModel: async () => '',
        savePrReviewModel: async () => true,
        loadUltrafixRatingGoal: async () => 6,
        saveUltrafixRatingGoal: async () => true,
        loadUltrafixMaxCycles: async () => 5,
        saveUltrafixMaxCycles: async () => true,
        loadUltrafixPauseSeconds: async () => 60,
        saveUltrafixPauseSeconds: async () => true
      }
    });

    assert.equal(result.status, 200);
    assert.deepEqual(writes.get('settings'), { existing: true });
    assert.equal(writes.get('ultrafix_rating_goal'), 8);
  } finally {
    testDb.transaction = originalTransaction;
  }
});

test('saveSettingsWithRollback reports committed state when post-commit side effects fail', async () => {
  const originalTransaction = db.transaction.bind(db);
  const testDb = db as typeof db & { transaction: typeof db.transaction };
  let committed = false;
  let rolledBack = false;

  const trx = Object.assign(
    ((table: string) => ({
      insert: (_row: { key: string; value: string }) => ({
        onConflict: (_column: string) => ({
          merge: async () => {
            assert.equal(table, 'system_configs');
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
        worker_concurrency: 9
      },
      publishConfigUpdate: async () => {
        published += 1;
      },
      configStore: {
        loadSettings: async () => ({ existing: true }),
        handleSettingsSaveSideEffects: () => {
          throw new Error('cache invalidation failed');
        }
      }
    });

    assert.equal(result.status, 500);
    assert.deepEqual(result.body, {
      error: 'Settings were saved and distributed, but post-commit side effects failed on this API instance. Persisted settings may require a follow-up check.',
      committed: true
    });
    assert.equal(committed, true);
    assert.equal(rolledBack, false);
    assert.equal(published, 1);
  } finally {
    testDb.transaction = originalTransaction;
  }
});

test('saveSettingsWithRollback reports committed state when publishing the settings update fails after commit', async () => {
  const originalTransaction = db.transaction.bind(db);
  const testDb = db as typeof db & { transaction: typeof db.transaction };

  const trx = Object.assign(
    ((table: string) => ({
      insert: (_row: { key: string; value: string }) => ({
        onConflict: (_column: string) => ({
          merge: async () => {
            assert.equal(table, 'system_configs');
          }
        })
      })
    })) as unknown as typeof db,
    {
      commit: async () => {},
      rollback: async () => {}
    }
  );

  testDb.transaction = async () => trx as never;

  try {
    const result = await saveSettingsWithRollback({
      settings: {
        worker_concurrency: 9
      },
      publishConfigUpdate: async () => {
        throw new Error('publish failed');
      },
      configStore: {
        loadSettings: async () => ({ existing: true }),
        handleSettingsSaveSideEffects: () => {}
      }
    });

    assert.equal(result.status, 500);
    assert.deepEqual(result.body, {
      error: 'Settings were saved, but publishing the settings update notification failed. Other processes may still be using stale configuration.',
      committed: true
    });
  } finally {
    testDb.transaction = originalTransaction;
  }
});

test('saveSettingsWithRollback surfaces lock loss before commit through withConfigLock', async () => {
  const originalTransaction = db.transaction.bind(db);
  const testDb = db as typeof db & { transaction: typeof db.transaction };
  const redisState = new Map<string, string>();
  let committed = false;
  let published = 0;

  const trx = Object.assign(
    ((table: string) => ({
      insert: (row: { key: string; value: string }) => ({
        onConflict: (_column: string) => ({
          merge: async () => {
            assert.equal(table, 'system_configs');
            if (row.key === 'settings') {
              redisState.set('config:test:lock', 'someone-else');
            }
          }
        })
      })
    })) as unknown as typeof db,
    {
      commit: async () => {
        committed = true;
      },
      rollback: async () => {}
    }
  );

  testDb.transaction = async () => trx as never;

  try {
    const result = await withConfigLock(
      {
        set: async (key: string, value: string, opts: { NX?: boolean; EX?: number }) => {
          if (opts.NX && redisState.has(key)) return null;
          redisState.set(key, value);
          return 'OK';
        },
        eval: async (_script: string, options: { keys: string[]; arguments: string[] }) => {
          const [key] = options.keys;
          const [lockValue, timeoutSeconds] = options.arguments;
          if (timeoutSeconds === undefined) {
            if (redisState.get(key) === lockValue) {
              redisState.delete(key);
              return 1;
            }
            return 0;
          }
          return redisState.get(key) === lockValue ? 1 : 0;
        }
      } as never,
      'config:test:lock',
      async lock => saveSettingsWithRollback({
        settings: { worker_concurrency: 9 },
        publishConfigUpdate: async () => {
          published += 1;
        },
        configStore: {
          loadSettings: async () => ({ existing: true }),
          handleSettingsSaveSideEffects: () => {}
        },
        lock
      }),
      { renewalIntervalMs: 0 }
    );

    assert.equal(result.status, 409);
    assert.deepEqual(result.body, {
      error: 'Configuration update lock was lost before the operation completed. Verify the current configuration before retrying.',
      lock_lost: true
    });
    assert.equal(committed, false);
    assert.equal(published, 0);
    assert.equal(redisState.get('config:test:lock'), 'someone-else');
  } finally {
    testDb.transaction = originalTransaction;
  }
});

test('saveSettingsWithRollback preserves committed lock-loss warnings when the lock is lost during publish', async () => {
  const originalTransaction = db.transaction.bind(db);
  const testDb = db as typeof db & { transaction: typeof db.transaction };
  const redisState = new Map<string, string>();

  const trx = Object.assign(
    ((table: string) => ({
      insert: (_row: { key: string; value: string }) => ({
        onConflict: (_column: string) => ({
          merge: async () => {
            assert.equal(table, 'system_configs');
          }
        })
      })
    })) as unknown as typeof db,
    {
      commit: async () => {},
      rollback: async () => {}
    }
  );

  testDb.transaction = async () => trx as never;

  try {
    let published = 0;
    const result = await withConfigLock(
      {
        set: async (key: string, value: string, opts: { NX?: boolean; EX?: number }) => {
          if (opts.NX && redisState.has(key)) return null;
          redisState.set(key, value);
          return 'OK';
        },
        eval: async (_script: string, options: { keys: string[]; arguments: string[] }) => {
          const [key] = options.keys;
          const [lockValue, timeoutSeconds] = options.arguments;
          if (timeoutSeconds === undefined) {
            if (redisState.get(key) === lockValue) {
              redisState.delete(key);
              return 1;
            }
            return 0;
          }
          return redisState.get(key) === lockValue ? 1 : 0;
        }
      } as never,
      'config:test:lock',
      async lock => saveSettingsWithRollback({
        settings: { worker_concurrency: 9 },
        publishConfigUpdate: async () => {
          redisState.set('config:test:lock', 'someone-else');
          await new Promise(resolve => setTimeout(resolve, 20));
          published += 1;
        },
        configStore: {
          loadSettings: async () => ({ existing: true }),
          handleSettingsSaveSideEffects: () => {}
        },
        lock
      }),
      { timeoutSeconds: 1, renewalIntervalMs: 10 }
    );

    assert.equal(result.status, 200);
    assert.deepEqual(result.body, {
      success: true,
      settings: { worker_concurrency: 9 },
      warning: 'Configuration changes were committed, but the update lock was lost afterward. Verify the current configuration before retrying.',
      committed: true,
      lock_lost_after_commit: true
    });
    assert.equal(published, 1);
    assert.equal(redisState.get('config:test:lock'), 'someone-else');
  } finally {
    testDb.transaction = originalTransaction;
  }
});

test('saveSettingsWithRollback clears general settings when given an empty settings object', async () => {
  const originalTransaction = db.transaction.bind(db);
  const testDb = db as typeof db & { transaction: typeof db.transaction };
  const writes = new Map<string, unknown>();

  const trx = Object.assign(
    ((table: string) => ({
      insert: (row: { key: string; value: string }) => ({
        onConflict: (_column: string) => ({
          merge: async () => {
            assert.equal(table, 'system_configs');
            writes.set(row.key, JSON.parse(row.value));
          }
        })
      })
    })) as unknown as typeof db,
    {
      commit: async () => {},
      rollback: async () => {}
    }
  );

  testDb.transaction = async () => trx as never;

  try {
    const result = await saveSettingsWithRollback({
      settings: {},
      publishConfigUpdate: async () => {},
      configStore: {
        loadSettings: async () => ({
          worker_concurrency: 8,
          planner_generation_model: 'gpt-test'
        }),
        handleSettingsSaveSideEffects: () => {},
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
        loadUltrafixPauseSeconds: async () => 60,
        saveUltrafixPauseSeconds: async () => true
      }
    });

    assert.equal(result.status, 200);
    assert.deepEqual(writes.get('settings'), {});
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
