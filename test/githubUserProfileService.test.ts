import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, mock, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import knex from 'knex';
import { down, up } from '../packages/core/src/db/migrations/20261012000000_create_github_user_profiles.js';
import {
    MAX_TASK_ASSIGNMENT_FILTER_LOGINS,
    formatTaskAssignmentFilter,
    parseTaskAssignmentFilter,
} from '../packages/shared/src/assignment.js';

const root = await mkdtemp(path.join(tmpdir(), 'github-user-profiles-'));
process.env.DATA_DIR = root;
process.env.DB_FILENAME = path.join(root, 'core.sqlite');
process.env.NODE_ENV = 'test';

const { db, runMigrations, closeConnection } = await import('../packages/core/src/db/connection.js');
const { default: logger } = await import('../packages/core/src/utils/logger.js');
const {
    rememberGitHubUserProfiles,
    loadGitHubUserProfiles,
    resolveGitHubUserProfiles,
    resolveGitHubUserProfileByLogin,
    resetUnresolvedGitHubUserIds,
} = await import('../packages/core/src/services/githubUserProfileService.js');
type GitHubUserProfileClient = import('../packages/core/src/services/githubUserProfileService.js').GitHubUserProfileClient;

const T0 = new Date('2026-10-08T10:00:00.000Z');
const HOUR = 60 * 60 * 1000;

function fakeGitHub(users: Record<string, { login: string; name?: string | null }>, options: { fail?: boolean } = {}) {
    const calls: Array<{ route: string; parameters: Record<string, string | number> }> = [];
    const client: GitHubUserProfileClient = {
        async request(route, parameters) {
            calls.push({ route, parameters });
            if (options.fail) throw new Error('GitHub is down');
            const id = route === 'GET /user/{account_id}'
                ? String(parameters.account_id)
                : Object.keys(users).find(candidate => users[candidate].login.toLowerCase() === String(parameters.username).toLowerCase());
            const user = id ? users[id] : undefined;
            if (!id || !user) throw Object.assign(new Error('Not Found'), { status: 404 });
            return { data: { id: Number(id), login: user.login, name: user.name ?? null, avatar_url: `https://avatars.example/u/${id}` } };
        },
    };
    return { client, calls };
}

describe('github_user_profiles migration', () => {
    test('creates the table with a login index and drops it on rollback', async () => {
        const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
        try {
            await up(database);
            const columns = await database('github_user_profiles').columnInfo();
            assert.deepEqual(Object.keys(columns).sort(), ['avatar_url', 'created_at', 'display_name', 'github_user_id', 'login', 'refreshed_at', 'updated_at']);
            const indexes = await database.raw("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'github_user_profiles'");
            assert.ok(indexes.some((index: { name: string }) => index.name === 'github_user_profiles_login_index'));
            await down(database);
            assert.equal(await database.schema.hasTable('github_user_profiles'), false);
        } finally {
            await database.destroy();
        }
    });
});

describe('githubUserProfileService', () => {
    before(async () => { await runMigrations(); });
    beforeEach(async () => {
        await db('github_user_profiles').delete();
        resetUnresolvedGitHubUserIds();
    });
    after(async () => {
        await closeConnection();
        await rm(root, { recursive: true, force: true });
    });

    test('rememberGitHubUserProfiles is an idempotent upsert that refreshes updated_at', async () => {
        const payload = [{ id: 101, login: 'octocat', avatar_url: 'https://avatars.example/u/101', name: 'Mona' }];
        assert.equal(await rememberGitHubUserProfiles(payload, T0), 1);
        const later = new Date(T0.getTime() + HOUR);
        assert.equal(await rememberGitHubUserProfiles(payload, later), 1);

        const rows = await db('github_user_profiles').select();
        assert.equal(rows.length, 1);
        assert.equal(rows[0].github_user_id, '101');
        assert.equal(rows[0].created_at, T0.toISOString());
        assert.equal(rows[0].updated_at, later.toISOString());
        assert.equal(rows[0].refreshed_at, later.toISOString());
    });

    test('rememberGitHubUserProfiles keeps fields a payload omits and ignores malformed entries', async () => {
        await rememberGitHubUserProfiles([{ id: '101', login: 'octocat', name: 'Mona', avatar_url: 'https://a/1' }], T0);
        // Webhook user objects omit `name`; a rename must not erase the display name.
        assert.equal(await rememberGitHubUserProfiles([
            { id: 101, login: 'octo-renamed' },
            null,
            { id: 'not-a-number', login: 'nope' },
            { id: 7, login: '' },
        ], T0), 1);
        const profiles = await loadGitHubUserProfiles(['101']);
        assert.deepEqual(profiles.get('101'), { id: '101', login: 'octo-renamed', displayName: 'Mona', avatarUrl: 'https://a/1' });
        assert.equal(await db('github_user_profiles').count('* as count').first().then(row => Number(row?.count)), 1);
    });

    test('loadGitHubUserProfiles batch-reads only cached rows', async () => {
        await rememberGitHubUserProfiles([
            { id: 1, login: 'alice', avatarUrl: 'https://a/1', displayName: 'Alice' },
            { id: 2, login: 'bob' },
        ], T0);
        const profiles = await loadGitHubUserProfiles(['1', 2, '3', '1', null, undefined, 'bogus']);
        assert.deepEqual([...profiles.keys()].sort(), ['1', '2']);
        assert.deepEqual(profiles.get('1'), { id: '1', login: 'alice', displayName: 'Alice', avatarUrl: 'https://a/1' });
        assert.deepEqual(profiles.get('2'), { id: '2', login: 'bob', displayName: null, avatarUrl: null });
        assert.equal((await loadGitHubUserProfiles([])).size, 0);
    });

    test('resolveGitHubUserProfiles fetches each unknown id once and caches the result', async () => {
        const github = fakeGitHub({ '10': { login: 'ten', name: 'Ten' }, '11': { login: 'eleven' } });
        const first = await resolveGitHubUserProfiles(['10', '11', '10'], { github: github.client, now: () => T0 });
        assert.deepEqual(github.calls.map(call => call.parameters.account_id).sort(), [10, 11]);
        assert.deepEqual(first.get('10'), { id: '10', login: 'ten', displayName: 'Ten', avatarUrl: 'https://avatars.example/u/10' });

        const second = await resolveGitHubUserProfiles(['10', '11'], { github: github.client, now: () => new Date(T0.getTime() + HOUR) });
        assert.equal(github.calls.length, 2, 'fresh entries are served from the cache');
        assert.equal(second.get('11')?.login, 'eleven');
        assert.equal((await loadGitHubUserProfiles(['10', '11'])).size, 2);
    });

    test('resolveGitHubUserProfiles refreshes entries older than the staleness window', async () => {
        await rememberGitHubUserProfiles([{ id: 20, login: 'old-login', name: null, avatar_url: null }], T0);
        const github = fakeGitHub({ '20': { login: 'new-login' } });

        const inside = await resolveGitHubUserProfiles(['20'], { github: github.client, staleAfterMs: 2 * HOUR, now: () => new Date(T0.getTime() + HOUR) });
        assert.equal(inside.get('20')?.login, 'old-login');
        assert.equal(github.calls.length, 0);

        const outside = await resolveGitHubUserProfiles(['20'], { github: github.client, staleAfterMs: 2 * HOUR, now: () => new Date(T0.getTime() + 3 * HOUR) });
        assert.equal(outside.get('20')?.login, 'new-login');
        assert.equal(github.calls.length, 1);
        assert.equal((await loadGitHubUserProfiles(['20'])).get('20')?.login, 'new-login');
    });

    test('resolveGitHubUserProfiles returns cached entries and warns when GitHub fails', async () => {
        await rememberGitHubUserProfiles([{ id: 30, login: 'cached' }, { id: 31, login: 'stale' }], T0);
        await db('github_user_profiles').where('github_user_id', '31').update({ refreshed_at: '2020-01-01T00:00:00.000Z' });
        const github = fakeGitHub({}, { fail: true });
        const warn = mock.method(logger, 'warn');

        let profiles;
        try {
            profiles = await resolveGitHubUserProfiles(['30', '31', '32', '33'], { github: github.client, now: () => T0 });
        } finally {
            warn.mock.restore();
        }
        assert.ok(warn.mock.calls.some(call => String(call.arguments[1]).includes('serving cached entries')));
        assert.deepEqual([...profiles.keys()].sort(), ['30', '31']);
        assert.equal(profiles.get('31')?.login, 'stale');
        assert.equal(github.calls.length, 1, 'a GitHub failure stops further lookups in the same call');
    });

    test('resolveGitHubUserProfiles skips ids GitHub does not know', async () => {
        const github = fakeGitHub({ '40': { login: 'forty' } });
        const profiles = await resolveGitHubUserProfiles(['40', '41'], { github: github.client, now: () => T0 });
        assert.deepEqual([...profiles.keys()], ['40']);
        assert.equal(github.calls.length, 2);
    });

    test('partial payloads update what they carry but do not postpone a full refresh', async () => {
        await rememberGitHubUserProfiles([{ id: 70, login: 'mona', name: 'Old Name', avatar_url: 'https://a/70' }], T0);
        const github = fakeGitHub({ '70': { login: 'mona', name: 'New Name' } });
        // Webhook payloads without `name` keep arriving after the name changed on GitHub.
        for (let hour = 1; hour <= 72; hour += 12) {
            await rememberGitHubUserProfiles([{ id: 70, login: 'mona', avatar_url: 'https://a/70' }], new Date(T0.getTime() + hour * HOUR));
        }
        const row = await db('github_user_profiles').where('github_user_id', '70').first();
        assert.equal(row.refreshed_at, T0.toISOString(), 'a partial payload does not count as a full refresh');
        assert.equal(row.display_name, 'Old Name', 'a partial payload still does not erase the name');

        const later = () => new Date(T0.getTime() + 73 * HOUR);
        const resolved = await resolveGitHubUserProfiles(['70'], { github: github.client, now: later });
        assert.equal(resolved.get('70')?.displayName, 'New Name');
        assert.equal(github.calls.length, 1);

        await db('github_user_profiles').where('github_user_id', '70').update({ refreshed_at: T0.toISOString() });
        await rememberGitHubUserProfiles([{ id: 70, login: 'mona' }], later());
        assert.equal((await resolveGitHubUserProfileByLogin('mona', { github: github.client, now: later }))?.displayName, 'New Name');
        assert.equal(github.calls.length, 2, 'the login resolver also refetches a profile only partially observed');
    });

    test('a profile first seen without a name is hydrated from GitHub', async () => {
        await rememberGitHubUserProfiles([{ id: 71, login: 'nameless', avatar_url: 'https://a/71' }], T0);
        assert.equal((await db('github_user_profiles').where('github_user_id', '71').first()).refreshed_at, null);
        const github = fakeGitHub({ '71': { login: 'nameless', name: 'Has A Name' } });

        const byId = await resolveGitHubUserProfiles(['71'], { github: github.client, now: () => T0 });
        assert.equal(byId.get('71')?.displayName, 'Has A Name');
        assert.equal(github.calls.length, 1);
        assert.equal((await resolveGitHubUserProfiles(['71'], { github: github.client, now: () => T0 })).get('71')?.displayName, 'Has A Name');
        assert.equal(github.calls.length, 1, 'once hydrated, the profile is fresh');

        await rememberGitHubUserProfiles([{ id: 72, login: 'nameless-two' }], T0);
        const github2 = fakeGitHub({ '72': { login: 'nameless-two', name: 'Two' } });
        assert.equal((await resolveGitHubUserProfileByLogin('nameless-two', { github: github2.client, now: () => T0 }))?.displayName, 'Two');
        assert.equal(github2.calls.length, 1);
    });

    test('ids GitHub does not know stop starving the ids after them, and are retried later', async () => {
        const ids = Array.from({ length: 51 }, (_, index) => String(1000 + index));
        const github = fakeGitHub({ '1050': { login: 'survivor' } });

        const first = await resolveGitHubUserProfiles(ids, { github: github.client, now: () => T0 });
        assert.equal(github.calls.length, 50, 'the per-call budget still holds');
        assert.equal(first.size, 0);

        const second = await resolveGitHubUserProfiles(ids, { github: github.client, now: () => new Date(T0.getTime() + 60_000) });
        assert.equal(second.get('1050')?.login, 'survivor');
        assert.deepEqual(github.calls.slice(50).map(call => call.parameters.account_id), [1050], 'unresolved ids are not asked again right away');

        const afterWindow = () => new Date(T0.getTime() + 2 * HOUR);
        await resolveGitHubUserProfiles(ids, { github: github.client, now: afterWindow });
        assert.equal(github.calls.length, 51 + 50, 'missing accounts are eventually retried');
    });

    test('an unresolved id observed in a payload is no longer skipped', async () => {
        const missing = fakeGitHub({});
        await resolveGitHubUserProfiles(['80'], { github: missing.client, now: () => T0 });
        await rememberGitHubUserProfiles([{ id: 80, login: 'back', name: 'Back', avatar_url: 'https://a/80' }], T0);
        await db('github_user_profiles').where('github_user_id', '80').update({ refreshed_at: null });

        const github = fakeGitHub({ '80': { login: 'back', name: 'Back Again' } });
        const profiles = await resolveGitHubUserProfiles(['80'], { github: github.client, now: () => T0 });
        assert.equal(profiles.get('80')?.displayName, 'Back Again');
        assert.equal(github.calls.length, 1);
    });

    test('resolveGitHubUserProfileByLogin turns a login into a stable id', async () => {
        const github = fakeGitHub({ '50': { login: 'Hubot', name: 'Hubot' } });
        const resolved = await resolveGitHubUserProfileByLogin('@hubot', { github: github.client, now: () => T0 });
        assert.deepEqual(resolved, { id: '50', login: 'Hubot', displayName: 'Hubot', avatarUrl: 'https://avatars.example/u/50' });
        assert.equal(github.calls.length, 1);

        const cached = await resolveGitHubUserProfileByLogin('HUBOT', { github: github.client, now: () => T0 });
        assert.equal(cached?.id, '50');
        assert.equal(github.calls.length, 1, 'a fresh cached login is not re-fetched');

        assert.equal(await resolveGitHubUserProfileByLogin('nobody', { github: github.client, now: () => T0 }), null);
        assert.equal(await resolveGitHubUserProfileByLogin('  ', { github: github.client }), null);

        const failing = fakeGitHub({}, { fail: true });
        const stale = await resolveGitHubUserProfileByLogin('hubot', { github: failing.client, now: () => new Date(T0.getTime() + 48 * HOUR) });
        assert.equal(stale?.id, '50', 'a GitHub failure falls back to the stale cached entry');
    });

    test('resolveGitHubUserProfileByLogin picks the newest holder across case variants', async () => {
        await rememberGitHubUserProfiles([{ id: 50, login: 'Hubot', name: null, avatar_url: null }], T0);
        await rememberGitHubUserProfiles([{ id: 60, login: 'hubot', name: null, avatar_url: null }], new Date(T0.getTime() + HOUR));
        const github = fakeGitHub({});
        const now = () => new Date(T0.getTime() + 2 * HOUR);

        for (const login of ['Hubot', 'hubot', 'HUBOT']) {
            assert.equal((await resolveGitHubUserProfileByLogin(login, { github: github.client, now }))?.id, '60', login);
        }
        assert.equal(github.calls.length, 0, 'the fresh newest holder is served from the cache');
    });
});

describe('parseTaskAssignmentFilter', () => {
    test('accepts all and me keywords', () => {
        for (const value of [undefined, null, '', '  ', 'all', 'ALL']) {
            assert.deepEqual(parseTaskAssignmentFilter(value), { ok: true, filter: { mode: 'all' } });
        }
        assert.deepEqual(parseTaskAssignmentFilter(' Me '), { ok: true, filter: { mode: 'me' } });
    });

    test('trims and de-duplicates logins case-insensitively', () => {
        const parsed = parseTaskAssignmentFilter(' octocat, @Hubot ,OCTOCAT,,hubot, propr-dev[bot] ');
        assert.deepEqual(parsed, { ok: true, filter: { mode: 'users', logins: ['octocat', 'Hubot', 'propr-dev[bot]'] } });
        assert.ok(parsed.ok);
        assert.equal(formatTaskAssignmentFilter(parsed.filter), 'octocat,Hubot,propr-dev[bot]');
        assert.deepEqual(parseTaskAssignmentFilter(' , '), { ok: true, filter: { mode: 'all' } });
    });

    test('round-trips explicit users named like keywords', () => {
        for (const value of ['@all', '@me', '@ALL', '@Me', 'all ,', 'ME,']) {
            const parsed = parseTaskAssignmentFilter(value);
            assert.ok(parsed.ok && parsed.filter.mode === 'users', value);
            const formatted = formatTaskAssignmentFilter(parsed.filter);
            assert.deepEqual(parseTaskAssignmentFilter(formatted), parsed, `${value} -> ${formatted}`);
        }
        assert.equal(formatTaskAssignmentFilter({ mode: 'users', logins: ['Me'] }), '@Me');
        assert.equal(formatTaskAssignmentFilter({ mode: 'users', logins: ['all', 'me'] }), 'all,me');
        assert.equal(formatTaskAssignmentFilter({ mode: 'all' }), 'all');
        assert.equal(formatTaskAssignmentFilter({ mode: 'me' }), 'me');
    });

    test('rejects invalid logins, non-strings and over-long lists', () => {
        assert.equal(parseTaskAssignmentFilter('octo cat').ok, false);
        assert.equal(parseTaskAssignmentFilter('-leading').ok, false);
        assert.equal(parseTaskAssignmentFilter('a'.repeat(40)).ok, false);
        assert.equal(parseTaskAssignmentFilter(['me']).ok, false);
        const atLimit = Array.from({ length: MAX_TASK_ASSIGNMENT_FILTER_LOGINS }, (_, index) => `user${index}`);
        assert.equal(parseTaskAssignmentFilter(atLimit.join(',')).ok, true);
        assert.equal(parseTaskAssignmentFilter([...atLimit, 'one-more'].join(',')).ok, false);
        // Duplicates do not count toward the limit.
        assert.equal(parseTaskAssignmentFilter([...atLimit, 'USER0'].join(',')).ok, true);
    });
});
