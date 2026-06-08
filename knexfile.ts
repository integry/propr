import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';
import type { Knex } from 'knex';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface KnexConfig {
    development: Knex.Config;
    production: Knex.Config;
}

type BetterSqliteConnection = { pragma: (arg: string) => unknown };

// Default database path
const defaultDbPath = path.join(__dirname, 'data', 'propr.sqlite');
const dbFilename = process.env.DB_FILENAME ?? defaultDbPath;
const DEFAULT_SQLITE_BUSY_TIMEOUT_MS = 30000;

function getSqliteBusyTimeoutMs(): number {
    const parsed = Number(process.env.SQLITE_BUSY_TIMEOUT_MS);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_SQLITE_BUSY_TIMEOUT_MS;
}

function configureSqliteConnection(conn: BetterSqliteConnection): void {
    conn.pragma(`busy_timeout = ${getSqliteBusyTimeoutMs()}`);
    conn.pragma('journal_mode = WAL');
    conn.pragma('synchronous = NORMAL');
    conn.pragma('foreign_keys = ON');
}

const config: KnexConfig = {
    development: {
        client: 'better-sqlite3',
        connection: {
            filename: dbFilename
        },
        useNullAsDefault: true,
        migrations: {
            directory: path.join(__dirname, 'packages/core/src/db/migrations'),
            tableName: 'knex_migrations'
        },
        pool: {
            afterCreate: (conn: BetterSqliteConnection, done: (err: Error | null) => void) => {
                configureSqliteConnection(conn);
                done(null);
            }
        }
    },

    production: {
        client: 'better-sqlite3',
        connection: {
            filename: dbFilename
        },
        useNullAsDefault: true,
        migrations: {
            directory: path.join(__dirname, 'packages/core/src/db/migrations'),
            tableName: 'knex_migrations'
        },
        pool: {
            afterCreate: (conn: BetterSqliteConnection, done: (err: Error | null) => void) => {
                configureSqliteConnection(conn);
                done(null);
            }
        }
    }
};

export default config;
