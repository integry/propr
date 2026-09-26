import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
/** D1 API adapter only: runs routing's exact SQL, including triggers and batches. */
export function routingDatabase(schema: string) {
  const SQLite = require('better-sqlite3');
  const sqlite = new SQLite(':memory:');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('recursive_triggers = ON');
  sqlite.exec(schema);
  function prepare(sql: string, values: unknown[] = []) {
    let slot = 0;
    const ordered: unknown[] = [];
    const translated = sql.replace(/\?(\d*)/g, (_match, number: string) => {
      const index = number ? Number(number) : slot + 1;
      slot = Math.max(slot, index); ordered.push(values[index - 1]); return '?';
    });
    const run = () => {
      const statement = sqlite.prepare(translated);
      if (statement.reader) return { results: statement.all(...ordered), meta: { changes: sqlite.prepare('SELECT changes() AS n').get().n }, success: true };
      return { results: [], meta: { changes: statement.run(...ordered).changes }, success: true };
    };
    return { bind: (...args: unknown[]) => prepare(sql, args),
      first: async (column?: string) => { const row = sqlite.prepare(translated).get(...ordered); return column ? row?.[column] ?? null : row ?? null; },
      all: async () => run(), run: async () => run(), execute: run };
  }
  return { prepare, batch: async (statements: ReturnType<typeof prepare>[]) => sqlite.transaction(() => statements.map(s => s.execute()))(),
    close: () => sqlite.close() };
}
