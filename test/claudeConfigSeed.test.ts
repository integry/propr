import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    CLAUDE_BACKUPS_CONTAINER_PATH,
    CLAUDE_JSON_SEED_CONTAINER_PATH,
    claudeConfigDockerArgs,
    claudeConfigSeedScript,
    resolveClaudeJsonSource,
} from '../packages/core/src/claude/docker/claudeConfigSeed.ts';
import { wrapDockerRunArgsWithRepoSetup } from '../packages/core/src/claude/docker/repoSetupWrapper.ts';
import { buildDockerArgs as buildClaudeDockerArgs } from '../packages/core/src/agents/impl/utils/dockerArgsBuilder.ts';
import type { AgentConfig } from '../packages/core/src/agents/types.ts';
import { closeConnection } from '../packages/core/src/db/connection.ts';

after(async () => {
    await closeConnection();
});

function tempDir(): string {
    return mkdtempSync(join(tmpdir(), 'propr-claude-seed-'));
}

function optionValues(args: string[], option: string): string[] {
    return args.filter((_, i) => args[i - 1] === option);
}

function withClaudeJsonPath(value: string | undefined, run: () => void): void {
    const previous = process.env.CLAUDE_JSON_PATH;
    try {
        if (value === undefined) delete process.env.CLAUDE_JSON_PATH;
        else process.env.CLAUDE_JSON_PATH = value;
        run();
    } finally {
        if (previous === undefined) delete process.env.CLAUDE_JSON_PATH;
        else process.env.CLAUDE_JSON_PATH = previous;
    }
}

describe('Claude config source selection', () => {
    test('prefers the launcher-provided CLAUDE_JSON_PATH over the backend home', () => {
        const host = tempDir();
        const home = tempDir();
        writeFileSync(join(host, '.claude.json'), '{}');
        writeFileSync(join(home, '.claude.json'), '{}');
        assert.equal(resolveClaudeJsonSource({ CLAUDE_JSON_PATH: join(host, '.claude.json') }, home), join(host, '.claude.json'));
    });

    test('falls back to the backend home when CLAUDE_JSON_PATH is unset', () => {
        const home = tempDir();
        writeFileSync(join(home, '.claude.json'), '{}');
        assert.equal(resolveClaudeJsonSource({}, home), join(home, '.claude.json'));
    });

    test('returns undefined when the selected file does not exist or is not a file', () => {
        const home = tempDir();
        assert.equal(resolveClaudeJsonSource({}, home), undefined);
        assert.equal(resolveClaudeJsonSource({ CLAUDE_JSON_PATH: join(home, 'missing.json') }, home), undefined);
        mkdirSync(join(home, '.claude.json'));
        assert.equal(resolveClaudeJsonSource({}, home), undefined);
    });
});

describe('Claude agent docker args', () => {
    const config: AgentConfig = {
        id: 'claude', alias: 'claude', type: 'claude', enabled: true,
        dockerImage: 'propr/agent:test', configPath: '/host/home/.claude',
    } as AgentConfig;
    const params = { worktreePath: '/tmp/worktree', githubToken: 'token', issueNumber: 7 };

    test('seeds from CLAUDE_JSON_PATH through a read-only mount and never binds the host file into HOME', () => {
        const host = tempDir();
        const claudeJson = join(host, '.claude.json');
        writeFileSync(claudeJson, '{"userID":"host"}');
        withClaudeJsonPath(claudeJson, () => {
            const args = buildClaudeDockerArgs(config, 10, params);
            assert.deepEqual(optionValues(args, '--mount'), [
                `type=bind,source=${claudeJson},target=${CLAUDE_JSON_SEED_CONTAINER_PATH},readonly`,
            ]);
            assert.ok(args.includes(`PROPR_CLAUDE_JSON_SEED=${CLAUDE_JSON_SEED_CONTAINER_PATH}`));
            assert.equal(args.some(arg => arg.endsWith(':/home/node/.claude.json:rw')), false);
            assert.ok(args.includes('/host/home/.claude:/home/node/.claude:rw'), 'credential dir mount is unchanged');
        });
    });

    test('still starts without a host file: no seed mount, private backups and a seeded minimal config', () => {
        withClaudeJsonPath(join(tempDir(), 'missing.json'), () => {
            const args = buildClaudeDockerArgs(config, 10, params);
            assert.deepEqual(optionValues(args, '--mount'), []);
            assert.ok(args.includes(`PROPR_CLAUDE_JSON_SEED=${CLAUDE_JSON_SEED_CONTAINER_PATH}`));
            assert.ok(optionValues(args, '--tmpfs').some(value => value.startsWith(`${CLAUDE_BACKUPS_CONTAINER_PATH}:`)));
            const wrapper = args[args.indexOf('-lc') + 1];
            assert.ok(wrapper.includes(claudeConfigSeedScript()), 'the wrapper seeds the config before the entrypoint');
        });
    });

    test('backups always live on a per-container tmpfs', () => {
        for (const source of ['/host/.claude.json', undefined]) {
            const tmpfs = optionValues(claudeConfigDockerArgs(source), '--tmpfs');
            assert.deepEqual(tmpfs, [`${CLAUDE_BACKUPS_CONTAINER_PATH}:rw,nosuid,nodev,noexec,size=16m`]);
        }
    });

    test('the repo setup wrapper runs the seed step before handing off to the entrypoint', () => {
        const wrapped = wrapDockerRunArgsWithRepoSetup(['run', 'propr/agent:test', 'claude', '-p', '-'], 'propr/agent:test', 'claude');
        const script = wrapped[wrapped.indexOf('-lc') + 1];
        assert.ok(script.indexOf(claudeConfigSeedScript()) < script.indexOf('exec "$entrypoint" "$@"'));
    });
});

describe('Claude config seed script', () => {
    function runSeed(seed: string | undefined, target: string): ReturnType<typeof spawnSync> {
        return spawnSync('/bin/bash', ['-c', `set -e\n${claudeConfigSeedScript(target)}\necho seeded`], {
            env: { PATH: process.env.PATH, ...(seed === undefined ? {} : { PROPR_CLAUDE_JSON_SEED: seed }) },
            encoding: 'utf8',
        });
    }

    test('regression: a backup without a config no longer blocks the run, and backups are untouched', () => {
        // Shape of the reported install: earlier agent runs left a backup in the
        // shared ~/.claude/backups while ~/.claude.json was missing.
        const home = tempDir();
        const backups = join(home, '.claude', 'backups');
        mkdirSync(backups, { recursive: true });
        writeFileSync(join(backups, '.claude.json.backup.1700000000000'), '{"firstStartTime":"stub"}');
        const target = join(home, '.claude.json');

        const result = runSeed(join(home, 'no-host-file.json'), target);
        assert.equal(result.status, 0, String(result.stderr));
        assert.deepEqual(JSON.parse(readFileSync(target, 'utf8')), {});
        assert.deepEqual(readdirSync(backups), ['.claude.json.backup.1700000000000']);
    });

    test('copies the host file into a private config the run can replace without touching the host file', () => {
        const home = tempDir();
        const seed = join(home, 'host.json');
        writeFileSync(seed, '{"userID":"host","hasCompletedOnboarding":true}');
        const target = join(home, '.claude.json');

        assert.equal(runSeed(seed, target).status, 0);
        assert.deepEqual(JSON.parse(readFileSync(target, 'utf8')), { userID: 'host', hasCompletedOnboarding: true });
        writeFileSync(target, '{"changed":true}');
        assert.equal(readFileSync(seed, 'utf8'), '{"userID":"host","hasCompletedOnboarding":true}');
    });

    test('never overwrites an existing config and does nothing for non-Claude containers', () => {
        const home = tempDir();
        const seed = join(home, 'host.json');
        writeFileSync(seed, '{"userID":"host"}');
        const existing = join(home, 'existing.json');
        writeFileSync(existing, '{"keep":true}');
        assert.equal(runSeed(seed, existing).status, 0);
        assert.equal(readFileSync(existing, 'utf8'), '{"keep":true}');

        const untouched = join(home, 'other-agent.json');
        assert.equal(runSeed(undefined, untouched).status, 0);
        assert.throws(() => readFileSync(untouched));
    });
});
