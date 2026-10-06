import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    parseBooleanSetting,
    resolveAutoResolveMergeConflicts,
    resolveRepositoryAutoResolveMergeConflictsOverride,
} from '../src/config/mergeConflictSettingsResolution.js';

const repo = (name: string, autoResolveMergeConflicts?: boolean | null) => ({ name, autoResolveMergeConflicts });

test('parses stored booleans, strings and JSON-encoded strings; rejects everything else', () => {
    assert.equal(parseBooleanSetting(true), true);
    assert.equal(parseBooleanSetting(false), false);
    assert.equal(parseBooleanSetting('true'), true);
    assert.equal(parseBooleanSetting('false'), false, 'the string "false" must not read as enabled');
    assert.equal(parseBooleanSetting('"false"'), false);
    assert.equal(parseBooleanSetting(' TRUE '), true);
    assert.equal(parseBooleanSetting(null), null);
    assert.equal(parseBooleanSetting(undefined), null);
    assert.equal(parseBooleanSetting(1), null);
    assert.equal(parseBooleanSetting('yes'), null);
});

test('a repository true overrides an instance false', () => {
    assert.deepEqual(
        resolveAutoResolveMergeConflicts({ repos: [repo('o/r', true)], repository: 'o/r', instanceDefault: false }),
        { enabled: true, source: 'repository', repositoryOverride: true, instanceDefault: false }
    );
});

test('a repository false overrides an instance true', () => {
    assert.deepEqual(
        resolveAutoResolveMergeConflicts({ repos: [repo('o/r', false)], repository: 'o/r', instanceDefault: true }),
        { enabled: false, source: 'repository', repositoryOverride: false, instanceDefault: true }
    );
});

test('an unset, null or legacy repository entry inherits the instance value', () => {
    for (const instanceDefault of [true, false]) {
        for (const entry of [repo('o/r'), repo('o/r', null), { name: 'o/r' }]) {
            assert.deepEqual(
                resolveAutoResolveMergeConflicts({ repos: [entry], repository: 'o/r', instanceDefault }),
                { enabled: instanceDefault, source: 'instance', repositoryOverride: null, instanceDefault }
            );
        }
    }
    assert.equal(resolveAutoResolveMergeConflicts({ repos: [], repository: 'o/r', instanceDefault: undefined }).enabled, false);
    assert.equal(resolveAutoResolveMergeConflicts({ repos: [], repository: 'o/r', instanceDefault: 'false' }).enabled, false);
});

test('repository names match case-insensitively and the override is shared across branch entries', () => {
    const repos = [repo('other/repo', false), repo('Owner/Repo'), repo('owner/repo', true)];
    assert.equal(resolveRepositoryAutoResolveMergeConflictsOverride(repos, 'OWNER/REPO'), true);
    assert.equal(resolveRepositoryAutoResolveMergeConflictsOverride(repos, 'owner/unknown'), null);
});
