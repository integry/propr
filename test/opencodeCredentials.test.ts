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
    test('keeps auth.json credentials imported from an OpenCode 1.x store with an empty credential table', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-credentials-'));
        try {
            const sourceDir = path.join(dir, 'source');
            const runtimeDir = path.join(dir, 'runtime');
            fs.mkdirSync(sourceDir);
            fs.mkdirSync(runtimeDir);
            const sourceDb = path.join(sourceDir, 'opencode.db');
            const runtimeDb = path.join(runtimeDir, 'opencode.db');

            // OpenCode 1.x data directory: credentials in auth.json, empty credential table.
            fs.writeFileSync(path.join(sourceDir, 'auth.json'), JSON.stringify({
                openai: { type: 'oauth', refresh: 'refresh-1', access: 'access-1', expires: 1 },
                openrouter: { type: 'api', key: 'router-key' }
            }));
            runSql(sourceDb, createCredentialTable);

            // `opencode auth list --standalone` has already imported auth.json into the runtime DB.
            runSql(runtimeDb, `${createCredentialTable};
                INSERT INTO credential VALUES ('cred-openai', 'openai', 'OpenAI', '{"access":"access-1"}', NULL, 'oauth', 1, 1, 1);
                INSERT INTO credential VALUES ('cred-openrouter', 'openrouter', 'OpenRouter', '{"key":"router-key"}', NULL, 'api', 1, 1, 1);`);

            runCredentials('seed', sourceDb, runtimeDb);

            assert.deepStrictEqual(
                querySql(runtimeDb, 'SELECT id, value FROM credential ORDER BY id'),
                [['cred-openai', '{"access":"access-1"}'], ['cred-openrouter', '{"key":"router-key"}']]
            );
            assert.deepStrictEqual(querySql(runtimeDb, "SELECT name FROM sqlite_master WHERE name='propr_original_credential'"), []);

            // A refresh during the task must not insert rows into the legacy source table.
            runSql(runtimeDb, `UPDATE credential SET value='{"access":"access-2"}', time_updated=2 WHERE id='cred-openai'`);
            runCredentials('sync', sourceDb, runtimeDb);
            assert.deepStrictEqual(querySql(sourceDb, 'SELECT count(*) FROM credential'), [[0]]);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
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
            assert.deepStrictEqual(querySql(runtimeDb, 'SELECT id, value FROM propr_original_credential'), [['cred-openai', 'token-1']]);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
