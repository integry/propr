/**
 * Per-container Claude Code configuration (`~/.claude.json`).
 *
 * Claude Code replaces `~/.claude.json` atomically (temp file + rename), copies
 * it into `~/.claude/backups` before each save, and prunes that directory to the
 * five newest backups. If the config is missing but a backup exists it refuses
 * to start. Bind-mounting the host file read-write is therefore unsafe, and
 * letting containers write into the shared `~/.claude/backups` both adds stub
 * backups and deletes the host login's own backups.
 *
 * So each Claude agent container gets:
 *  - the host `.claude.json` (when one exists) bind-mounted read-only at a seed
 *    path outside HOME,
 *  - a private writable `~/.claude.json` copied from that seed by the wrapper
 *    before the agent starts, or a minimal valid config when there is no seed,
 *  - a private tmpfs over `~/.claude/backups`, so the host's backups are never
 *    read, added to or pruned by an agent run.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CLAUDE_JSON_CONTAINER_PATH = '/home/node/.claude.json';
export const CLAUDE_JSON_SEED_CONTAINER_PATH = '/run/propr-claude/claude.json';
export const CLAUDE_BACKUPS_CONTAINER_PATH = '/home/node/.claude/backups';
export const CLAUDE_JSON_SEED_ENV = 'PROPR_CLAUDE_JSON_SEED';

interface ClaudeJsonEnvironment {
    CLAUDE_JSON_PATH?: string;
}

/**
 * The host `.claude.json` to seed agent containers from, or undefined when none
 * exists. The launcher passes the host file's path as CLAUDE_JSON_PATH (mounted
 * HOST:HOST into the worker/api); without it the backend's own home is used,
 * which matches dev/compose setups that run the worker with the real home.
 */
export function resolveClaudeJsonSource(
    environment: ClaudeJsonEnvironment = process.env,
    homeDir: string = os.homedir()
): string | undefined {
    const configured = environment.CLAUDE_JSON_PATH?.trim();
    const candidate = configured || path.join(homeDir, '.claude.json');
    try {
        return fs.statSync(candidate).isFile() ? candidate : undefined;
    } catch {
        return undefined;
    }
}

function mountField(key: string, value: string): string {
    return /[",]/.test(value)
        ? `"${key}=${value.replace(/"/g, '""')}"`
        : `${key}=${value}`;
}

/**
 * Docker run options giving one Claude agent container its private config.
 *
 * `--mount` rather than `-v` for the seed: a source removed after the backend
 * checked it must fail the run, never be created as a directory at the path of
 * the user's config file.
 */
export function claudeConfigDockerArgs(source: string | undefined = resolveClaudeJsonSource()): string[] {
    return [
        ...(source
            ? ['--mount', ['type=bind', mountField('source', source), mountField('target', CLAUDE_JSON_SEED_CONTAINER_PATH), 'readonly'].join(',')]
            : []),
        '--tmpfs', `${CLAUDE_BACKUPS_CONTAINER_PATH}:rw,nosuid,nodev,noexec,size=16m`,
        '-e', `${CLAUDE_JSON_SEED_ENV}=${CLAUDE_JSON_SEED_CONTAINER_PATH}`,
    ];
}

/**
 * Shell run by the agent wrapper (as root, before the entrypoint drops to the
 * node user) to create the private config. It only runs for containers that set
 * PROPR_CLAUDE_JSON_SEED and never overwrites an existing config.
 */
export function claudeConfigSeedScript(target: string = CLAUDE_JSON_CONTAINER_PATH): string {
    if (target.includes("'")) throw new Error('Claude config target must not contain a single quote');
    return `
if [ -n "\${${CLAUDE_JSON_SEED_ENV}:-}" ] && [ ! -e '${target}' ]; then
    if ! { [ -f "$${CLAUDE_JSON_SEED_ENV}" ] && cp "$${CLAUDE_JSON_SEED_ENV}" '${target}' 2>/dev/null; }; then
        printf '{}\\n' > '${target}' 2>/dev/null || true
    fi
    chown node:node '${target}' 2>/dev/null || true
    chmod 600 '${target}' 2>/dev/null || true
fi`.trim();
}
