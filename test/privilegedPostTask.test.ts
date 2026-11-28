import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Agent entrypoints start as root, run the task as node, and then copy a few
// task-written files back to host mounts. scripts/task-file-transfer.py is the
// only way those copies may happen: it reads as node and writes with the
// entrypoint's privileges, never following a symlink and never committing a
// partial or oversized file. scripts/privileged-post-task.sh wraps every such
// step in a fixed PATH. These tests drive both directly.

const TRANSFER = path.join(process.cwd(), 'scripts/task-file-transfer.py');
const HELPER = path.join(process.cwd(), 'scripts/privileged-post-task.sh');
const ENTRYPOINTS = fs.readdirSync(path.join(process.cwd(), 'scripts')).filter(name => name.endsWith('-entrypoint.sh'));

function withSandbox(body: (dir: string) => void): void {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'propr-post-task-')));
    try {
        body(dir);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

const transfer = (args: string[], input?: Buffer | string) => spawnSync('/usr/bin/python3', ['-I', TRANSFER, ...args], { input });

/** read | write, as propr_copy_task_file_back runs them. */
function copy(sourceRoot: string, sourceRel: string, destRoot: string, destRel: string, max = 1024, mode = '0600', ...flags: string[]) {
    const reader = transfer([sourceRel.startsWith('match:') ? 'read-match' : 'read', sourceRoot, sourceRel.replace(/^match:/, ''), String(max)]);
    const writer = transfer(['write', destRoot, destRel, String(max), mode, ...flags], reader.stdout);
    return { reader: reader.status, writer: writer.status, stderr: `${reader.stderr}${writer.stderr}` };
}

describe('task-file-transfer.py', { skip: fs.existsSync('/usr/bin/python3') ? false : 'needs /usr/bin/python3' }, () => {
    test('copies a regular file, keeps the destination mode and leaves no temp file', () => {
        withSandbox(dir => {
            fs.mkdirSync(path.join(dir, 'runtime'));
            fs.mkdirSync(path.join(dir, 'host'));
            fs.writeFileSync(path.join(dir, 'runtime', 'auth.json'), 'refreshed', { mode: 0o644 });
            fs.writeFileSync(path.join(dir, 'host', 'auth.json'), 'seeded', { mode: 0o640 });
            assert.deepEqual(copy(path.join(dir, 'runtime'), 'auth.json', path.join(dir, 'host'), 'auth.json'), { reader: 0, writer: 0, stderr: '' });
            assert.equal(fs.readFileSync(path.join(dir, 'host', 'auth.json'), 'utf8'), 'refreshed');
            assert.equal(fs.statSync(path.join(dir, 'host', 'auth.json')).mode & 0o777, 0o640);
            assert.deepEqual(fs.readdirSync(path.join(dir, 'host')), ['auth.json']);
        });
    });

    test('a new destination gets the given mode, and --parents creates its directories', () => {
        withSandbox(dir => {
            fs.mkdirSync(path.join(dir, 'runtime', 'cli'), { recursive: true });
            fs.mkdirSync(path.join(dir, 'host'));
            fs.writeFileSync(path.join(dir, 'runtime', 'cli', 'token'), 'token');
            assert.equal(copy(path.join(dir, 'runtime'), 'cli/token', path.join(dir, 'host'), 'cli/token').writer, 2, 'missing parents are refused without --parents');
            assert.equal(copy(path.join(dir, 'runtime'), 'cli/token', path.join(dir, 'host'), 'cli/token', 1024, '0600', '--parents').writer, 0);
            assert.equal(fs.readFileSync(path.join(dir, 'host', 'cli', 'token'), 'utf8'), 'token');
            assert.equal(fs.statSync(path.join(dir, 'host', 'cli', 'token')).mode & 0o777, 0o600);
        });
    });

    test('a missing source is reported as nothing to copy and leaves the destination alone', () => {
        withSandbox(dir => {
            fs.mkdirSync(path.join(dir, 'host'));
            fs.writeFileSync(path.join(dir, 'host', 'auth.json'), 'seeded');
            assert.deepEqual(copy(path.join(dir, 'runtime'), 'auth.json', path.join(dir, 'host'), 'auth.json'), { reader: 3, writer: 3, stderr: '' });
            assert.equal(fs.readFileSync(path.join(dir, 'host', 'auth.json'), 'utf8'), 'seeded');
        });
    });

    test('refuses a source that is a symlink, a hard link, sits under a symlinked directory, is not regular, or is too large', () => {
        withSandbox(dir => {
            const runtime = path.join(dir, 'runtime');
            fs.mkdirSync(path.join(runtime, 'real'), { recursive: true });
            fs.mkdirSync(path.join(dir, 'host'));
            fs.writeFileSync(path.join(dir, 'secret'), 'secret');
            fs.writeFileSync(path.join(dir, 'host', 'auth.json'), 'seeded');
            fs.symlinkSync(path.join(dir, 'secret'), path.join(runtime, 'symlink'));
            fs.linkSync(path.join(dir, 'secret'), path.join(runtime, 'hardlink'));
            fs.writeFileSync(path.join(runtime, 'real', 'auth.json'), 'via a linked directory');
            fs.symlinkSync(path.join(runtime, 'real'), path.join(runtime, 'linked'));
            fs.mkdirSync(path.join(runtime, 'directory'));
            fs.writeFileSync(path.join(runtime, 'large'), 'x'.repeat(2048));
            for (const [name, reason] of [['symlink', /symbolic link/], ['hardlink', /hard links/], ['linked/auth.json', /symbolic link/], ['directory', /not a regular file/], ['large', /larger than/]] as const) {
                const result = copy(runtime, name, path.join(dir, 'host'), 'auth.json');
                assert.equal(result.reader, 2, name);
                assert.notEqual(result.writer, 0, name);
                assert.match(result.stderr, reason, name);
                assert.equal(fs.readFileSync(path.join(dir, 'host', 'auth.json'), 'utf8'), 'seeded', `${name}: the host keeps its file`);
            }
        });
    });

    test('refuses a symlink in the destination path and replaces a destination symlink without writing through it', () => {
        withSandbox(dir => {
            fs.mkdirSync(path.join(dir, 'runtime'));
            fs.mkdirSync(path.join(dir, 'elsewhere'));
            fs.mkdirSync(path.join(dir, 'host'));
            fs.writeFileSync(path.join(dir, 'runtime', 'token'), 'token');
            fs.symlinkSync(path.join(dir, 'elsewhere'), path.join(dir, 'host', 'cli'));
            const linkedParent = copy(path.join(dir, 'runtime'), 'token', path.join(dir, 'host'), 'cli/token', 1024, '0600', '--parents');
            assert.equal(linkedParent.writer, 2);
            assert.match(linkedParent.stderr, /symbolic link or not a directory/);
            assert.deepEqual(fs.readdirSync(path.join(dir, 'elsewhere')), []);
            fs.symlinkSync(path.join(dir, 'host'), path.join(dir, 'linked-host'));
            assert.equal(copy(path.join(dir, 'runtime'), 'token', path.join(dir, 'linked-host'), 'token').writer, 2, 'a symlinked destination root is refused');

            fs.writeFileSync(path.join(dir, 'victim'), 'untouched');
            fs.symlinkSync(path.join(dir, 'victim'), path.join(dir, 'host', 'token'));
            assert.equal(copy(path.join(dir, 'runtime'), 'token', path.join(dir, 'host'), 'token', 1024, '0644', '--force-mode').writer, 0);
            assert.equal(fs.lstatSync(path.join(dir, 'host', 'token')).isFile(), true);
            assert.equal(fs.readFileSync(path.join(dir, 'host', 'token'), 'utf8'), 'token');
            assert.equal(fs.statSync(path.join(dir, 'host', 'token')).mode & 0o777, 0o644);
            assert.equal(fs.readFileSync(path.join(dir, 'victim'), 'utf8'), 'untouched');
        });
    });

    test('commits only a complete frame: truncated, padded, oversized or malformed input leaves the destination alone', () => {
        withSandbox(dir => {
            fs.mkdirSync(path.join(dir, 'host'));
            fs.writeFileSync(path.join(dir, 'host', 'auth.json'), 'seeded');
            for (const input of ['propr-task-file-v1 10\nshort', 'propr-task-file-v1 2\nok!', 'propr-task-file-v1 4096\n', 'garbage\n', 'propr-task-file-v1 -1\n']) {
                const result = transfer(['write', path.join(dir, 'host'), 'auth.json', '1024', '0600'], input);
                assert.equal(result.status, 2, JSON.stringify(input));
                assert.equal(fs.readFileSync(path.join(dir, 'host', 'auth.json'), 'utf8'), 'seeded');
                assert.deepEqual(fs.readdirSync(path.join(dir, 'host')), ['auth.json'], 'no temp file left behind');
            }
            assert.equal(transfer(['write', path.join(dir, 'host'), 'auth.json', '1024', '0600'], '').status, 3, 'empty input is nothing to copy');
            assert.equal(transfer(['write', path.join(dir, 'host'), '../auth.json', '1024', '0600'], 'propr-task-file-v1 0\n').status, 2, '.. is refused');
        });
    });

    test('read-match finds the transcript without following symlinked directories', () => {
        withSandbox(dir => {
            const brain = path.join(dir, 'brain');
            fs.mkdirSync(path.join(dir, 'outside', '.system_generated', 'logs'), { recursive: true });
            fs.writeFileSync(path.join(dir, 'outside', '.system_generated', 'logs', 'transcript.jsonl'), 'outside');
            fs.mkdirSync(brain);
            fs.symlinkSync(path.join(dir, 'outside'), path.join(brain, 'a-linked'));
            fs.mkdirSync(path.join(dir, 'out'));
            assert.equal(copy(brain, 'match:.system_generated/logs/transcript.jsonl', path.join(dir, 'out'), 'transcript.jsonl').reader, 3);
            fs.mkdirSync(path.join(brain, 'b-conversation', '.system_generated', 'logs'), { recursive: true });
            fs.writeFileSync(path.join(brain, 'b-conversation', '.system_generated', 'logs', 'transcript.jsonl'), '{"step":1}\n');
            assert.equal(copy(brain, 'match:.system_generated/logs/transcript.jsonl', path.join(dir, 'out'), 'transcript.jsonl').writer, 0);
            assert.equal(fs.readFileSync(path.join(dir, 'out', 'transcript.jsonl'), 'utf8'), '{"step":1}\n');
        });
    });
});

describe('privileged-post-task.sh', () => {
    test('run_privileged_post_task fixes PATH, empties the exported environment and keeps shell variables', () => {
        withSandbox(dir => {
            // A planted `env` first on PATH must not run: the step names /usr/bin/env.
            fs.writeFileSync(path.join(dir, 'env'), '#!/bin/sh\necho planted\n', { mode: 0o755 });
            const script = [
                // The helper path arrives as $1 so no path text is spliced into the script.
                '. "$1"',
                'shift',
                'shell_only=kept',
                'step() { printf "%s|%s|" "$shell_only" "$PWD"; /usr/bin/env | /usr/bin/sort | /usr/bin/tr "\\n" " "; }',
                'run_privileged_post_task WANTED=yes step',
            ].join('\n');
            const result = spawnSync('/bin/bash', ['-c', script, 'privileged-post-task-test', HELPER], {
                env: { PATH: `${dir}:/usr/bin:/bin`, SECRET_TOKEN: 'leak', BASH_ENV: path.join(dir, 'env'), LD_PRELOAD: 'nope' }, encoding: 'utf8', cwd: dir,
            });
            assert.equal(result.status, 0, result.stderr);
            const [shellOnly, cwd, environment] = result.stdout.split('|');
            assert.equal(shellOnly, 'kept');
            assert.equal(cwd, '/');
            assert.deepEqual(environment.trim().split(' ').filter(entry => !entry.startsWith('_=')).sort(), ['LC_ALL=C', 'PATH=/usr/sbin:/usr/bin:/sbin:/bin', 'WANTED=yes']);
        });
    });

    test('every entrypoint with work after the task sources the helper by its root-owned path and runs that work through it', () => {
        const supervisedEntrypoints = [];
        for (const name of ENTRYPOINTS) {
            const script = fs.readFileSync(path.join(process.cwd(), 'scripts', name), 'utf8');
            const call = /^\s*run_supervised_task .*$/m.exec(script);
            if (!call) {
                // Without supervision every task launch must replace the shell, leaving nothing to run after it.
                for (const line of script.split('\n').filter(candidate => /\b(?:su-exec|gosu) node\b/.test(candidate) && !/^\s*#/.test(candidate))) {
                    assert.match(line, /\bexec (?:su-exec|gosu) node\b|\$\(su-exec node|! su-exec node test /, `${name}: ${line.trim()}`);
                }
                continue;
            }
            supervisedEntrypoints.push(name);
            assert.match(script, /^\. \/opt\/propr\/privileged-post-task\.sh$/m, `${name} must source the shared helper`);
            const afterTask = script.slice(call.index + call[0].length, script.indexOf('exit "$command_status"', call.index));
            const steps = afterTask.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#') && !/^(?:if \[ -n "\$\w+" \]; then|fi)$/.test(line));
            assert.ok(steps.length > 0, `${name} has post-task steps`);
            for (const step of steps) assert.match(step, /^run_privileged_post_task \S/, `${name}: post-task step outside run_privileged_post_task: ${step}`);
            for (const trap of script.match(/^\s*trap '.*' EXIT$/gm) ?? []) assert.match(trap, /trap 'run_privileged_post_task /, `${name}: ${trap.trim()}`);
        }
        assert.deepEqual(supervisedEntrypoints.sort(), ['antigravity-entrypoint.sh', 'opencode-entrypoint.sh']);
    });

    test('the image installs entrypoints and the helper root-owned', () => {
        const dockerfile = fs.readFileSync(path.join(process.cwd(), 'Dockerfile.agent'), 'utf8');
        for (const name of ENTRYPOINTS) {
            const copy = dockerfile.split(/\n(?=COPY )/).find(block => block.startsWith('COPY ') && block.includes(`scripts/${name}`));
            assert.ok(copy, `${name} is copied into the image`);
            assert.doesNotMatch(copy, /--chown/, `${name} must be root-owned in the image`);
        }
        assert.match(dockerfile, /^COPY scripts\/privileged-post-task\.sh \/opt\/propr\/privileged-post-task\.sh$/m);
        assert.match(dockerfile, /^COPY scripts\/task-file-transfer\.py \/opt\/propr\/task-file-transfer\.py$/m);
    });
});
