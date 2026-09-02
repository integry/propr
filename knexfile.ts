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

type BetterSqliteConnection = {
    pragma: (arg: string, options?: { simple?: boolean }) => unknown;
};

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
    conn.pragma('recursive_triggers = ON');

    if (conn.pragma('foreign_keys', { simple: true }) !== 1) {
        throw new Error('SQLite foreign_keys pragma must be enabled');
    }
    if (conn.pragma('recursive_triggers', { simple: true }) !== 1) {
        throw new Error('SQLite recursive_triggers pragma must be enabled');
    }
}

function configurePooledSqliteConnection(
    conn: BetterSqliteConnection,
    done: (err: Error | null) => void
): void {
    try {
        configureSqliteConnection(conn);
        done(null);
    } catch (error) {
        done(error as Error);
    }
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
            afterCreate: configurePooledSqliteConnection
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
            afterCreate: configurePooledSqliteConnection
        }
    }
};

export default config;
