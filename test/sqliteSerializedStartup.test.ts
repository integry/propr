import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';

const root = resolve(import.meta.dirname, '..');
const tsx = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');

function runMigrationProcess(databasePath: string, migrationsPreapplied = false): Promise<{ code: number | null; output: string }> {
    return new Promise((resolveProcess, rejectProcess) => {
        const child = spawn(tsx, ['src/migrate.ts'], {
            cwd: root,
            env: {
                ...process.env,
                NODE_ENV: 'production',
                DB_FILENAME: databasePath,
                LOG_LEVEL: 'silent',
                PROPR_MIGRATIONS_PREAPPLIED: migrationsPreapplied ? '1' : '0',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let output = '';
        child.stdout.on('data', chunk => { output += chunk; });
        child.stderr.on('data', chunk => { output += chunk; });
        child.once('error', rejectProcess);
        child.once('close', code => resolveProcess({ code, output }));
    });
}

test('migration command owns blank startup and the preapplied gate skips a second owner', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'propr-serialized-startup-'));
    const databasePath = join(dataDirectory, 'propr.sqlite');

    try {
        const owner = await runMigrationProcess(databasePath);
        assert.equal(owner.code, 0, owner.output);

        // This is a fast process-level check of the migration command and gate,
        // not a model of production topology. The packaged five-service path is
        // exercised by scripts/smoke-test-sqlite-startup.sh.
        const skipped = await runMigrationProcess(databasePath, true);
        assert.equal(skipped.code, 0, skipped.output);

        const database = new Database(databasePath, { readonly: true });
        try {
            const migrationCount = database.prepare('SELECT COUNT(*) AS count FROM knex_migrations').get() as { count: number };
            assert.ok(migrationCount.count > 0);
            const lockRows = database.prepare('SELECT COUNT(*) AS count FROM knex_migrations_lock').get() as { count: number };
            assert.equal(lockRows.count, 1);
        } finally {
            database.close();
        }

        // Upgraded/initialized databases still pass through the same owner
        // phase; a second run must remain successful and leave the schema current.
        const upgraded = await runMigrationProcess(databasePath);
        assert.equal(upgraded.code, 0, upgraded.output);
    } finally {
        await rm(dataDirectory, { recursive: true, force: true });
    }
});

test('an older build on a database a newer version migrated stops with a version message, not knex\'s "corrupt directory"', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'propr-newer-database-'));
    const databasePath = join(dataDirectory, 'propr.sqlite');

    try {
        const owner = await runMigrationProcess(databasePath);
        assert.equal(owner.code, 0, owner.output);

        // A newer ProPR version applied two migrations this checkout does not ship.
        const database = new Database(databasePath);
        try {
            const insert = database.prepare('INSERT INTO knex_migrations (name, batch, migration_time) VALUES (?, 99, CURRENT_TIMESTAMP)');
            insert.run('29990101000000_from_a_newer_version.js');
            insert.run('29990102000000_latest_from_a_newer_version.js');
        } finally {
            database.close();
        }

        const older = await runMigrationProcess(databasePath);
        assert.equal(older.code, 1, older.output);
        assert.match(older.output, /^This database was migrated by a newer ProPR version \(2 newer migrations, latest: 29990102000000_latest_from_a_newer_version\.js\)\. Start that version or newer, or restore a backup taken before the upgrade\.$/m);
        assert.doesNotMatch(older.output, /corrupt/);
        assert.doesNotMatch(older.output, /^\s+at /m, 'no stack trace');
    } finally {
        await rm(dataDirectory, { recursive: true, force: true });
    }
});
