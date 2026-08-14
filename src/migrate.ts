import 'dotenv/config';
// Import the database module directly so this infrastructure-only command does
// not initialize unrelated GitHub/Redis application modules from the core
// package barrel before credentials or dependent services are available.
import { closeConnection, runMigrations } from '../packages/core/src/db/connection.js';

// Packaged stack startup runs this command to completion before creating any
// database-using service containers. Keeping the migration owner as a separate
// process serializes Knex's migration-table bootstrap on a completely blank
// SQLite database as well as all subsequent schema migrations.
try {
    await runMigrations();
} finally {
    await closeConnection();
}
