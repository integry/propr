import knex, { type Knex } from 'knex';

type BetterSqliteConnection = {
  pragma(statement: string): unknown;
};

export interface BackgroundDatabase {
  database: Knex;
  close(): Promise<void>;
}

export function sqliteFilename(database: Knex): string | undefined {
  const connection = database.client.config.connection;
  if (typeof connection === 'string') return connection;
  if (connection && typeof connection === 'object' && 'filename' in connection) {
    const filename = (connection as { filename?: unknown }).filename;
    return typeof filename === 'string' && filename ? filename : undefined;
  }
  return undefined;
}

/**
 * Create the connection used by optional API background work.
 *
 * better-sqlite3's busy handler waits synchronously. That is appropriate for
 * foreground writes which must complete, but it can freeze every HTTP request
 * when best-effort work races a writer in another process. This connection
 * fails lock acquisition immediately so callers can retry with an asynchronous
 * timer instead of occupying the API event loop.
 */
export async function createBackgroundDatabase(source: Knex): Promise<BackgroundDatabase> {
  const client = source.client.config.client;
  const filename = sqliteFilename(source);

  // An in-memory SQLite database cannot be reopened without creating a new,
  // empty database. Non-SQLite deployments do not have better-sqlite3's
  // synchronous busy handler. In both cases retain the supplied connection.
  if (client !== 'better-sqlite3' || !filename || filename === ':memory:') {
    return { database: source, close: async () => undefined };
  }

  const database = knex({
    client: 'better-sqlite3',
    connection: { filename },
    useNullAsDefault: true,
    pool: {
      min: 1,
      max: 1,
      afterCreate(
        connection: BetterSqliteConnection,
        done: (error: Error | null, connection?: BetterSqliteConnection) => void,
      ): void {
        try {
          connection.pragma('busy_timeout = 0');
          connection.pragma('foreign_keys = ON');
          connection.pragma('recursive_triggers = ON');
          done(null, connection);
        } catch (error) {
          done(error as Error);
        }
      },
    },
  });

  // Open the connection during startup. Lazy initialization on the first task
  // event would move connection setup back onto the latency-sensitive path.
  await database.raw('SELECT 1');
  return { database, close: () => database.destroy() };
}
