import { parentPort, workerData } from 'node:worker_threads';
import knex from 'knex';
import { loadCompletedRows } from '../routes/dashboardOutcomeQueries.js';

if (!parentPort) throw new Error('Dashboard read worker requires a parent port');
const port = parentPort;
const db = knex({
  client: 'better-sqlite3',
  connection: { filename: workerData.filename, options: { readonly: true } },
  useNullAsDefault: true,
});
await db.raw('SELECT 1');
port.postMessage({ type: 'ready' });
// Serialize whole projections, not just their individual SQL statements.
let tail = Promise.resolve();
port.on('message', (request: { id: number; repository: string; options: { limit?: number; search?: string } }) => {
  tail = tail.then(async () => {
    try {
      const rows = await loadCompletedRows(db, request.repository, request.options);
      port.postMessage({ id: request.id, rows });
    } catch (error) {
      port.postMessage({ id: request.id, error: error instanceof Error ? error.message : 'Dashboard read failed' });
    }
  });
});
