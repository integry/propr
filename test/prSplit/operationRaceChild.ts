import knex from 'knex';
import {
  createOrGetPrSplitOperation,
} from '../../packages/core/src/services/prSplit/commandStore.js';
import type {
  CreatePrSplitOperationInput,
} from '../../packages/core/src/services/prSplit/operationStore.js';

const [filename, serializedInput, startAtValue] = process.argv.slice(2);
if (!filename || !serializedInput || !startAtValue) {
  throw new Error('Operation race child requires database, input, and start time arguments');
}

const input = JSON.parse(serializedInput) as CreatePrSplitOperationInput;
const startAt = Number(startAtValue);
const delay = Math.max(0, startAt - Date.now());
await new Promise<void>(resolve => setTimeout(resolve, delay));

const database = knex({
  client: 'better-sqlite3',
  connection: { filename },
  useNullAsDefault: true,
  pool: { min: 1, max: 1 },
});

try {
  await database.raw('PRAGMA busy_timeout = 1000');
  const result = await createOrGetPrSplitOperation(input, database);
  process.stdout.write(JSON.stringify({
    outcome: result.receipt.outcome,
    processId: process.pid,
  }));
} finally {
  await database.destroy();
}
