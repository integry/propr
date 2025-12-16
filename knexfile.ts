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

// Default database path
const defaultDbPath = path.join(__dirname, 'data', 'gitfix.sqlite');
const dbFilename = process.env.DB_FILENAME ?? defaultDbPath;

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
            afterCreate: (conn: { pragma: (arg: string) => void }, done: (err: Error | null) => void) => {
                // Enable foreign keys for SQLite
                conn.pragma('foreign_keys = ON');
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
            afterCreate: (conn: { pragma: (arg: string) => void }, done: (err: Error | null) => void) => {
                conn.pragma('foreign_keys = ON');
                done(null);
            }
        }
    }
};

export default config;
