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

// Importing the helper (observeTempModes) must not leave scripts/__pycache__ behind.
function runPython(args: string[]): string {
    return execFileSync('python3', ['-I', ...args], {
        encoding: 'utf8',
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }
    });
}

function python(code: string, ...args: string[]): string {
    return runPython(['-c', code, ...args]);
}

function runSql(dbPath: string, sql: string): void {
    python('import sqlite3, sys\nwith sqlite3.connect(sys.argv[1]) as db: db.executescript(sys.argv[2])', dbPath, sql);
}

function querySql(dbPath: string, sql: string): unknown[] {
    return JSON.parse(python('import json, sqlite3, sys\nprint(json.dumps(sqlite3.connect(sys.argv[1]).execute(sys.argv[2]).fetchall()))', dbPath, sql));
}

function runCredentials(action: 'seed' | 'sync', sourceDb: string, runtimeDb: string): void {
    runPython([credentialsScript, action, sourceDb, runtimeDb]);
}

describe('opencode-credentials.py', () => {
    // OpenCode 1.x host stores. 1.19.6 creates an empty credential table and never reads it.
    type HostShape = 'empty credential table' | 'auth.json only' | 'database without credential table';

    // What `opencode auth list --standalone` (2.4.2) imports from a v1 auth.json
    // into a fresh disposable database; row ids are random on every run.
    function importAuthJson(runtimeDb: string, authJson: string, run: number): void {
        const auth = JSON.parse(fs.readFileSync(authJson, 'utf8')) as Record<string, Record<string, unknown>>;
        const rows = Object.entries(auth).map(([integration, entry], index) => {
            const value = entry.type === 'oauth'
                ? { type: 'oauth', methodID: 'oauth', refresh: entry.refresh, access: entry.access, expires: entry.expires }
                : { type: 'key', key: entry.key };
            return `INSERT INTO credential VALUES ('cred-run${run}-${index}', '${integration}', 'imported', '${JSON.stringify(value)}', NULL, NULL, NULL, ${run}, ${run});`;
        });
        runSql(runtimeDb, `${createCredentialTable}; ${rows.join('\n')}`);
    }

    function refreshOpenAi(runtimeDb: string, refresh: string): void {
        runSql(runtimeDb, `UPDATE credential SET time_updated=99,
            value='{"type":"oauth","methodID":"oauth","refresh":"${refresh}","access":"access-${refresh}","expires":99}'
            WHERE integration_id='openai'`);
    }

    function withAuthJsonHost(shape: HostShape, run: (dirs: { sourceDb: string; runtimeDir: string; authJson: string }) => void): void {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-credentials-'));
        try {
            const sourceDir = path.join(dir, 'source');
            const runtimeDir = path.join(dir, 'runtime');
            fs.mkdirSync(sourceDir);
            fs.mkdirSync(runtimeDir);
            const sourceDb = path.join(sourceDir, 'opencode.db');
            const authJson = path.join(sourceDir, 'auth.json');
            fs.writeFileSync(authJson, JSON.stringify({
                openai: { type: 'oauth', refresh: 'refresh-1', access: 'access-1', expires: 1, accountId: 'acct' },
                openrouter: { type: 'api', key: 'router-key' }
            }), { mode: 0o600 });
            // A pre-credential-table 1.x database: sessions only, no credential table.
            if (shape === 'database without credential table') runSql(sourceDb, 'CREATE TABLE session (id TEXT PRIMARY KEY)');
            if (shape === 'empty credential table') runSql(sourceDb, `CREATE TABLE session (id TEXT PRIMARY KEY); ${createCredentialTable}`);
            run({ sourceDb, runtimeDir, authJson });
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }

    // One container run: the entrypoint copies auth.json into the disposable
    // data dir, OpenCode imports it, then seed, the task, and sync.
    function containerRun(
        dirs: { sourceDb: string; runtimeDir: string; authJson: string },
        run: number,
        task: (runtimeDb: string) => void,
        sync: (sourceDb: string, runtimeDb: string) => void = (sourceDb, runtimeDb) => runCredentials('sync', sourceDb, runtimeDb)
    ): string {
        const runDir = path.join(dirs.runtimeDir, `run-${run}`);
        fs.mkdirSync(runDir);
        const runtimeDb = path.join(runDir, 'opencode.db');
        fs.copyFileSync(dirs.authJson, path.join(runDir, 'auth.json'));
        importAuthJson(runtimeDb, path.join(runDir, 'auth.json'), run);
        runCredentials('seed', dirs.sourceDb, runtimeDb);
        task(runtimeDb);
        sync(dirs.sourceDb, runtimeDb);
        return runtimeDb;
    }

    // Runs `sync` under the container umask (0022) and records the temp
    // file's mode whenever the script changes its mode or renames it.
    const observeTempModes = `
import json, os, runpy, stat, sys
os.umask(0o022)
script, log = sys.argv[1], sys.argv[2]
modes = []
def record(path):
    if "propr-tmp" in os.fspath(path):
        modes.append(stat.S_IMODE(os.lstat(path).st_mode))
real_chmod, real_replace = os.chmod, os.replace
def chmod(path, *args, **kwargs):
    record(path)
    return real_chmod(path, *args, **kwargs)
def replace(src, dst, *args, **kwargs):
    record(src)
    return real_replace(src, dst, *args, **kwargs)
os.chmod, os.replace = chmod, replace
sys.argv = [script, *sys.argv[3:]]
try:
    runpy.run_path(script, run_name="__main__")
finally:
    with open(log, "w") as handle:
        json.dump(modes, handle)
`;

    function hostSchema(sourceDb: string): unknown[] {
        return fs.existsSync(sourceDb) ? querySql(sourceDb, "SELECT name FROM sqlite_master ORDER BY name") : [];
    }

    function hostCredentialRows(sourceDb: string): unknown[] {
        const hasTable = fs.existsSync(sourceDb) && querySql(sourceDb, "SELECT 1 FROM sqlite_master WHERE name='credential'").length > 0;
        return hasTable ? querySql(sourceDb, 'SELECT * FROM credential') : [];
    }

    function seededOpenAiRefresh(runtimeDb: string): unknown[] {
        return querySql(runtimeDb, "SELECT json_extract(value, '$.refresh') FROM credential WHERE integration_id='openai'");
    }

    for (const shape of ['empty credential table', 'auth.json only', 'database without credential table'] as HostShape[]) {
        test(`writes OAuth refreshes back to auth.json for a host with ${shape}`, () => {
            withAuthJsonHost(shape, (dirs) => {
                const schemaBefore = hostSchema(dirs.sourceDb);
                containerRun(dirs, 1, (runtimeDb) => refreshOpenAi(runtimeDb, 'refresh-2'));

                // The refresh reaches the host in the v1 format; other fields and entries are kept.
                assert.deepStrictEqual(JSON.parse(fs.readFileSync(dirs.authJson, 'utf8')), {
                    openai: { type: 'oauth', refresh: 'refresh-2', access: 'access-refresh-2', expires: 99, accountId: 'acct' },
                    openrouter: { type: 'api', key: 'router-key' }
                });
                assert.strictEqual(fs.statSync(dirs.authJson).mode & 0o777, 0o600);
                assert.deepStrictEqual(fs.readdirSync(path.dirname(dirs.authJson)).filter((name) => name.includes('propr-tmp')), []);
                // The host database is untouched: none is created, and an empty
                // credential table stays empty (the 1.x CLI never reads it).
                assert.strictEqual(fs.existsSync(dirs.sourceDb), shape !== 'auth.json only');
                assert.deepStrictEqual(hostSchema(dirs.sourceDb), schemaBefore);
                assert.deepStrictEqual(hostCredentialRows(dirs.sourceDb), []);

                // The next run imports the refreshed token, and its refresh persists too.
                const next = containerRun(dirs, 2, (runtimeDb) => {
                    assert.deepStrictEqual(seededOpenAiRefresh(runtimeDb), [['refresh-2']]);
                    refreshOpenAi(runtimeDb, 'refresh-3');
                });
                assert.ok(fs.existsSync(next));
                assert.strictEqual(JSON.parse(fs.readFileSync(dirs.authJson, 'utf8')).openai.refresh, 'refresh-3');
                assert.deepStrictEqual(hostCredentialRows(dirs.sourceDb), []);
            });
        });

        test(`uses a host login made between runs for a host with ${shape}`, () => {
            withAuthJsonHost(shape, (dirs) => {
                containerRun(dirs, 1, (runtimeDb) => refreshOpenAi(runtimeDb, 'refresh-2'));

                // The 1.x host CLI logs in again; it only writes auth.json.
                const auth = JSON.parse(fs.readFileSync(dirs.authJson, 'utf8'));
                fs.writeFileSync(dirs.authJson, JSON.stringify({
                    ...auth,
                    openai: { type: 'oauth', refresh: 'host-login', access: 'host-access', expires: 5 }
                }));

                containerRun(dirs, 2, (runtimeDb) => assert.deepStrictEqual(seededOpenAiRefresh(runtimeDb), [['host-login']]));
                assert.deepStrictEqual(hostCredentialRows(dirs.sourceDb), []);
            });
        });

        test(`never exposes refreshed tokens in a group- or world-readable temp file for a host with ${shape}`, () => {
            withAuthJsonHost(shape, (dirs) => {
                const log = path.join(dirs.runtimeDir, 'temp-modes.json');
                containerRun(dirs, 1, (runtimeDb) => refreshOpenAi(runtimeDb, 'refresh-2'), (sourceDb, runtimeDb) => {
                    python(observeTempModes, credentialsScript, log, 'sync', sourceDb, runtimeDb);
                });
                const modes = JSON.parse(fs.readFileSync(log, 'utf8')) as number[];
                assert.ok(modes.length > 0, 'sync wrote auth.json through a temp file');
                for (const mode of modes) assert.strictEqual(mode & 0o077, 0, `temp file mode ${mode.toString(8)}`);
                assert.strictEqual(JSON.parse(fs.readFileSync(dirs.authJson, 'utf8')).openai.refresh, 'refresh-2');
                assert.strictEqual(fs.statSync(dirs.authJson).mode & 0o777, 0o600);
            });
        });

        test(`does not overwrite a host login made during the run for a host with ${shape}`, () => {
            withAuthJsonHost(shape, (dirs) => {
                const hostLogin = { type: 'oauth', refresh: 'host-login', access: 'host-access', expires: 5 };
                containerRun(dirs, 1, (runtimeDb) => {
                    // The task refreshes while the host CLI logs in again.
                    refreshOpenAi(runtimeDb, 'refresh-2');
                    const auth = JSON.parse(fs.readFileSync(dirs.authJson, 'utf8'));
                    fs.writeFileSync(dirs.authJson, JSON.stringify({ ...auth, openai: hostLogin }));
                });
                assert.deepStrictEqual(JSON.parse(fs.readFileSync(dirs.authJson, 'utf8')), {
                    openai: hostLogin,
                    openrouter: { type: 'api', key: 'router-key' }
                });
                assert.deepStrictEqual(hostCredentialRows(dirs.sourceDb), []);

                // The next run uses the host login.
                containerRun(dirs, 2, (runtimeDb) => assert.deepStrictEqual(seededOpenAiRefresh(runtimeDb), [['host-login']]));
            });
        });
    }

    // An OpenCode 2 host: its populated credential table is the host store.
    function withDatabaseHost(run: (sourceDb: string, runtimeDb: string, authJson: string) => void): void {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-credentials-'));
        try {
            const sourceDb = path.join(dir, 'opencode.db');
            const runtimeDb = path.join(dir, 'runtime.db');
            const authJson = path.join(dir, 'auth.json');
            // A stale legacy auth.json the host imported long ago.
            fs.writeFileSync(authJson, JSON.stringify({ openai: { type: 'oauth', refresh: 'legacy', access: 'legacy', expires: 1 } }));
            runSql(sourceDb, `${createCredentialTable};
                INSERT INTO credential VALUES ('cred-openai', 'openai', 'OpenAI', 'token-1', NULL, 'oauth', 1, 1, 1);
                INSERT INTO credential VALUES ('cred-router', 'openrouter', 'OpenRouter', 'router-key', NULL, 'api', 1, 1, 1);`);
            // `opencode auth list --standalone` imported the stale auth.json.
            runSql(runtimeDb, `${createCredentialTable};
                INSERT INTO credential VALUES ('stale', 'openai', 'Stale', 'stale-token', NULL, 'oauth', 1, 1, 1);`);
            run(sourceDb, runtimeDb, authJson);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }

    test('replaces runtime rows with the source rows when the source has OpenCode 2 credentials', () => {
        withDatabaseHost((sourceDb, runtimeDb) => {
            runCredentials('seed', sourceDb, runtimeDb);

            assert.deepStrictEqual(
                querySql(runtimeDb, 'SELECT id, value FROM credential ORDER BY id'),
                [['cred-openai', 'token-1'], ['cred-router', 'router-key']]
            );
            assert.deepStrictEqual(
                querySql(runtimeDb, 'SELECT id, value FROM propr_original_credential ORDER BY id'),
                [['cred-openai', 'token-1'], ['cred-router', 'router-key']]
            );
        });
    });

    test('writes refreshes back to a populated host credential table and leaves auth.json alone', () => {
        withDatabaseHost((sourceDb, runtimeDb, authJson) => {
            const authBefore = fs.readFileSync(authJson, 'utf8');
            runCredentials('seed', sourceDb, runtimeDb);
            runSql(runtimeDb, `UPDATE credential SET value='token-2', time_updated=2 WHERE id='cred-openai'`);
            runCredentials('sync', sourceDb, runtimeDb);

            assert.deepStrictEqual(
                querySql(sourceDb, 'SELECT id, value, time_updated FROM credential ORDER BY id'),
                [['cred-openai', 'token-2', 2], ['cred-router', 'router-key', 1]]
            );
            assert.strictEqual(fs.readFileSync(authJson, 'utf8'), authBefore);
        });
    });

    test('keeps a host credential replaced during the run', () => {
        withDatabaseHost((sourceDb, runtimeDb) => {
            runCredentials('seed', sourceDb, runtimeDb);
            runSql(runtimeDb, `UPDATE credential SET value='token-2', time_updated=2 WHERE id='cred-openai'`);
            runSql(sourceDb, `UPDATE credential SET value='host-login', time_updated=5 WHERE id='cred-openai'`);
            runCredentials('sync', sourceDb, runtimeDb);

            assert.deepStrictEqual(
                querySql(sourceDb, 'SELECT id, value FROM credential ORDER BY id'),
                [['cred-openai', 'host-login'], ['cred-router', 'router-key']]
            );
        });
    });

    test('does not restore a host credential deleted during the run', () => {
        withDatabaseHost((sourceDb, runtimeDb) => {
            runCredentials('seed', sourceDb, runtimeDb);
            runSql(runtimeDb, `UPDATE credential SET value='token-2', time_updated=2 WHERE id='cred-openai'`);
            runSql(sourceDb, `DELETE FROM credential WHERE id='cred-openai'`);
            runCredentials('sync', sourceDb, runtimeDb);

            assert.deepStrictEqual(querySql(sourceDb, 'SELECT id, value FROM credential ORDER BY id'), [['cred-router', 'router-key']]);
        });
    });
});
