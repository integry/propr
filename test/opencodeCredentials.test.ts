import { describe, test } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const credentialsScript = path.join(process.cwd(), 'scripts/opencode-credentials.py');

// Mirrors the OpenCode 2 credential columns the script transfers.
const createCredentialTable = `
CREATE TABLE credential (
    id TEXT PRIMARY KEY, integration_id TEXT, label TEXT, value TEXT, connector_id TEXT,
    method_id TEXT, active INTEGER, time_created INTEGER, time_updated INTEGER
)`;

function python(code: string, ...args: string[]): string {
    return execFileSync('python3', ['-I', '-c', code, ...args], { encoding: 'utf8' });
}

function runSql(dbPath: string, sql: string): void {
    python('import sqlite3, sys\nwith sqlite3.connect(sys.argv[1]) as db: db.executescript(sys.argv[2])', dbPath, sql);
}

function querySql(dbPath: string, sql: string): unknown[] {
    return JSON.parse(python('import json, sqlite3, sys\nprint(json.dumps(sqlite3.connect(sys.argv[1]).execute(sys.argv[2]).fetchall()))', dbPath, sql));
}

function runCredentials(action: 'seed' | 'sync', sourceDb: string, runtimeDb: string): void {
    execFileSync('python3', ['-I', credentialsScript, action, sourceDb, runtimeDb], { encoding: 'utf8' });
}

describe('opencode-credentials.py', () => {
    function withLegacyStore(run: (sourceDb: string, runtimeDb: string, authJson: string) => void): void {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-credentials-'));
        try {
            const sourceDir = path.join(dir, 'source');
            const runtimeDir = path.join(dir, 'runtime');
            fs.mkdirSync(sourceDir);
            fs.mkdirSync(runtimeDir);
            const sourceDb = path.join(sourceDir, 'opencode.db');
            const runtimeDb = path.join(runtimeDir, 'opencode.db');
            const authJson = path.join(sourceDir, 'auth.json');

            // OpenCode 1.x data directory: credentials in auth.json, empty credential table.
            fs.writeFileSync(authJson, JSON.stringify({
                openai: { type: 'oauth', refresh: 'refresh-1', access: 'access-1', expires: 1 },
                openrouter: { type: 'api', key: 'router-key' }
            }));
            runSql(sourceDb, createCredentialTable);

            // `opencode auth list --standalone` has already imported auth.json into the runtime DB.
            runSql(runtimeDb, `${createCredentialTable};
                INSERT INTO credential VALUES ('cred-openai', 'openai', 'OpenAI', '{"refresh":"refresh-1"}', NULL, 'oauth', 1, 1, 1);
                INSERT INTO credential VALUES ('cred-openrouter', 'openrouter', 'OpenRouter', '{"key":"router-key"}', NULL, 'api', 1, 1, 1);`);
            run(sourceDb, runtimeDb, authJson);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }

    test('moves auth.json credentials and their refreshes from an OpenCode 1.x store into the host database', () => {
        withLegacyStore((sourceDb, runtimeDb, authJson) => {
            const authBefore = fs.readFileSync(authJson, 'utf8');
            runCredentials('seed', sourceDb, runtimeDb);

            // The imported credentials survive seeding.
            assert.deepStrictEqual(
                querySql(runtimeDb, 'SELECT id, value FROM credential ORDER BY id'),
                [['cred-openai', '{"refresh":"refresh-1"}'], ['cred-openrouter', '{"key":"router-key"}']]
            );

            // OAuth refresh during the task.
            runSql(runtimeDb, `UPDATE credential SET value='{"refresh":"refresh-2"}', time_updated=2 WHERE id='cred-openai'`);
            runCredentials('sync', sourceDb, runtimeDb);

            assert.deepStrictEqual(
                querySql(sourceDb, 'SELECT id, integration_id, value, time_updated FROM credential ORDER BY id'),
                [
                    ['cred-openai', 'openai', '{"refresh":"refresh-2"}', 2],
                    ['cred-openrouter', 'openrouter', '{"key":"router-key"}', 1]
                ]
            );
            assert.strictEqual(fs.readFileSync(authJson, 'utf8'), authBefore);

            // The next task seeds from the host database, including the refreshed token.
            const nextRuntimeDb = path.join(path.dirname(runtimeDb), 'next.db');
            runSql(nextRuntimeDb, `${createCredentialTable};
                INSERT INTO credential VALUES ('cred-openai-reimport', 'openai', 'OpenAI', '{"refresh":"refresh-1"}', NULL, 'oauth', 1, 1, 1);`);
            runCredentials('seed', sourceDb, nextRuntimeDb);
            assert.deepStrictEqual(
                querySql(nextRuntimeDb, 'SELECT id, value FROM credential ORDER BY id'),
                [['cred-openai', '{"refresh":"refresh-2"}'], ['cred-openrouter', '{"key":"router-key"}']]
            );
            assert.deepStrictEqual(
                querySql(nextRuntimeDb, 'SELECT id, value, on_host FROM propr_original_credential ORDER BY id'),
                [['cred-openai', '{"refresh":"refresh-2"}', 1], ['cred-openrouter', '{"key":"router-key"}', 1]]
            );
        });
    });

    test('does not overwrite host credentials added while an OpenCode 1.x store was being migrated', () => {
        withLegacyStore((sourceDb, runtimeDb) => {
            runCredentials('seed', sourceDb, runtimeDb);
            runSql(runtimeDb, `UPDATE credential SET value='{"refresh":"refresh-2"}', time_updated=2 WHERE id='cred-openai'`);

            // The host gains rows during the run: one with the same id, one for the same integration.
            runSql(sourceDb, `
                INSERT INTO credential VALUES ('cred-openai', 'openai', 'OpenAI', '{"refresh":"host-login"}', NULL, 'oauth', 1, 5, 5);
                INSERT INTO credential VALUES ('cred-router-host', 'openrouter', 'OpenRouter', '{"key":"host-key"}', NULL, 'api', 1, 5, 5);`);
            runCredentials('sync', sourceDb, runtimeDb);

            assert.deepStrictEqual(
                querySql(sourceDb, 'SELECT id, value FROM credential ORDER BY id'),
                [['cred-openai', '{"refresh":"host-login"}'], ['cred-router-host', '{"key":"host-key"}']]
            );
        });
    });

    test('replaces runtime rows with the source rows when the source has OpenCode 2 credentials', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-credentials-'));
        try {
            const sourceDb = path.join(dir, 'source.db');
            const runtimeDb = path.join(dir, 'runtime.db');
            runSql(sourceDb, `${createCredentialTable};
                INSERT INTO credential VALUES ('cred-openai', 'openai', 'OpenAI', 'token-1', NULL, 'oauth', 1, 1, 1);`);
            runSql(runtimeDb, `${createCredentialTable};
                INSERT INTO credential VALUES ('stale', 'openai', 'Stale', 'stale-token', NULL, 'oauth', 1, 1, 1);`);

            runCredentials('seed', sourceDb, runtimeDb);

            assert.deepStrictEqual(querySql(runtimeDb, 'SELECT id, value FROM credential'), [['cred-openai', 'token-1']]);
            assert.deepStrictEqual(querySql(runtimeDb, 'SELECT id, value, on_host FROM propr_original_credential'), [['cred-openai', 'token-1', 1]]);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
