import assert from 'node:assert/strict';
import { after, test as nodeTest } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { executeDockerCommand } from '../src/claude/docker/dockerExecutor.js';
import { createRequire } from 'node:module';
import { parseRepositoryWorkflow, loadRepositoryWorkflow, refineWorkflowPreviews, repositoryWorkflowPrompt } from '../src/workflow/repositoryWorkflow.js';
import type { ResolvedRepositoryWorkflow } from '../src/workflow/repositoryWorkflow.js';
import { buildWorkflowWrapper, WORKFLOW_MARKER_TEMPLATE, WORKFLOW_WRAPPER_MAX_BYTES, executeWithRepositoryWorkflow, repositoryWorkflowExecution, captureWorkflowMarkers, REPOSITORY_VALIDATION_REPORT_MAX_LENGTH, withWorkflowExecutionDeadline } from '../src/workflow/workflowExecution.js';
import { AntigravityGoalStream } from '../src/agents/impl/antigravityGoalStream.js';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { generateCompletionComment } from '../src/utils/github/logFiles.js';
import { closeConnection } from '../src/db/connection.js';
import { MAX_PROVIDER_OUTPUT_BYTES } from '../src/agents/impl/utils/boundedProviderOutput.js';
import { wrapDockerRunArgsWithRepoSetup } from '../src/claude/docker/repoSetupWrapper.js';

/** Feed raw transport stderr through the same capture the Docker executor uses. */
function observeStderr(stderr: string, chunks = [stderr]): void {
    const context = repositoryWorkflowExecution.getStore()!;
    const capture = captureWorkflowMarkers([context.marker])!;
    for (const chunk of chunks.slice(0, -1)) capture.append(chunk);
    capture.finish(chunks.at(-1)!);
}

// Many tests spawn real Bash wrappers. A per-test bound names a stuck test
// instead of letting the whole file run into the suite's per-file timeout.
const TEST_TIMEOUT_MS = 60_000;
const test = (name: string, fn: () => unknown) => nodeTest(name, { timeout: TEST_TIMEOUT_MS }, fn);

// logFiles loads the SQLite connection, which otherwise keeps the test process alive.
after(async () => {
    await closeConnection();
});

const policy = (source = '{}'): ResolvedRepositoryWorkflow => ({
    revision: 'base-commit', fileRevision: 'blob', baseBranch: 'release', config: parseRepositoryWorkflow(source),
    timeoutMs: 1000, maxParallelTasks: 2,
});

test('rejects malformed and privilege-expanding policy with actionable field errors', () => {
    for (const source of [
        'null', '~', '[]', 'hooks: nope', 'hooks: { before_run: 1 }', 'hooks: { timeout_ms: 0 }',
        'hooks: { before_run: echo, before_run: other }', 'validation: npm test', 'validation: [null]',
        'previews: { types: [audio] }', 'previews: { types: [image, image] }',
        'limits: { max_parallel_tasks: 1.5 }', 'limits: { max_parallel_tasks: 0 }',
        'credentials: secret', 'network: host', 'mounts: [/etc]', 'hooks: { env: {} }',
        'instructions: /etc/passwd', 'instructions: ../secrets', 'instructions: .propr/../secrets',
        'instructions: "C:\\\\secrets"', 'instructions: ./test.md', 'instructions: a//b',
        'instructions: !custom file.md', 'validation: [&a npm, *a]',
    ]) assert.throws(() => parseRepositoryWorkflow(source), /Invalid .propr\/workflow.yml/, source);
    assert.deepEqual(parseRepositoryWorkflow('{}'), {});
    // A scaffold with every section commented out is the empty policy, not an error.
    for (const empty of ['', '\n', '# yaml-language-server: $schema=x\n# hooks:\n#   before_run: npm ci\n', '---\n# nothing\n']) {
        assert.deepEqual(parseRepositoryWorkflow(empty), {}, JSON.stringify(empty));
    }
    assert.throws(() => parseRepositoryWorkflow('a'.repeat(128 * 1024 + 1)), /exceeds 128 KiB/);
});

test('pins branch-specific policy and instructions to the same base revision and caps instance limits', async () => {
    const reads: string[] = [];
    const source = {
        resolveRevision: async (branch: string) => `${branch}-sha`,
        readFile: async (file: string, revision: string) => {
            reads.push(`${revision}:${file}`);
            return { sha: 'blob-sha', content: file.endsWith('.yml')
                ? 'instructions: .propr/instructions.md\nvalidation: [npm test]\nhooks: { timeout_ms: 999999 }\nlimits: { max_parallel_tasks: 100 }'
                : `Instructions from ${revision}` };
        },
    };
    const workflow = await loadRepositoryWorkflow(source, 'release/v2', { maxParallelTasks: 3, timeoutMs: 500 });
    assert.equal(workflow?.maxParallelTasks, 3);
    assert.equal(workflow?.timeoutMs, 500);
    assert.equal(workflow?.fileRevision, 'blob-sha');
    assert.deepEqual(reads, ['release/v2-sha:.propr/workflow.yml', 'release/v2-sha:.propr/instructions.md']);
    assert.match(repositoryWorkflowPrompt(workflow), /Instructions from release\/v2-sha/);
    assert.match(repositoryWorkflowPrompt(workflow), /npm test/);
    assert.equal((await loadRepositoryWorkflow(source, 'main', { maxParallelTasks: 1 }))?.instructionText, 'Instructions from main-sha');
    assert.equal(await loadRepositoryWorkflow({ ...source, readFile: async () => null }, 'main', { maxParallelTasks: 5 }), undefined);
    await assert.rejects(loadRepositoryWorkflow({ ...source, readFile: async file => file.endsWith('.yml') ? { content: 'instructions: missing.md', sha: 'blob' } : null }, 'main', { maxParallelTasks: 5 }), /missing.md.*does not exist/);
});

test('preview refinements cannot enable disabled types or discard instance instructions and capacity', () => {
    const workflow = policy('previews: { types: [image, video], instructions: "Capture settings" }');
    const defaults = { enabled: false, types: ['image' as const], instructions: 'Instance instructions' };
    const merged = refineWorkflowPreviews(defaults, workflow);
    assert.equal(merged.enabled, false);
    assert.deepEqual(merged.types, ['image']);
    assert.equal(merged.instructions, 'Instance instructions\n\nCapture settings');
    assert.equal(refineWorkflowPreviews({ ...defaults, enabled: true }, policy('previews: { types: [video] }')).enabled, false);
});

test('published editor schema agrees with runtime on supported fields and rejects extra privileges', async () => {
    const require = createRequire(import.meta.url);
    const Ajv = require('ajv');
    const schema = JSON.parse(await readFile(new URL('../../../docs/static/schemas/repository-workflow.schema.json', import.meta.url), 'utf8'));
    const validate = new Ajv().compile(schema);
    for (const candidate of [
        {}, { hooks: { timeout_ms: 4, before_run: 'npm test' } }, { instructions: '.propr/instructions.md' },
        { limits: { max_parallel_tasks: 8 }, previews: { types: [] }, validation: ['echo ok'] },
        { network: 'host' }, { hooks: { timeout_ms: -1 } }, { instructions: '../oops' }, { instructions: 'a//b' },
        { validation: [null] }, { limits: { max_parallel_tasks: 1.5 } }, { previews: { types: ['image', 'image'] } },
    ]) {
        let accepted = true;
        try { parseRepositoryWorkflow(JSON.stringify(candidate)); } catch { accepted = false; }
        assert.equal(validate(candidate), accepted, JSON.stringify(candidate));
    }
});

async function runWrapper(workflow: ResolvedRepositoryWorkflow, agent = 'echo agent >> "$TRACE"; cat', setup?: string, marker = 'marker', binaries: Record<string, string> = {}, env: string[] = []) {
    const directory = await mkdtemp(path.join(tmpdir(), 'workflow-test-'));
    const entrypoint = path.join(directory, 'agent.sh');
    const trace = path.join(directory, 'trace');
    await writeFile(entrypoint, `#!/bin/bash\n${agent}\n`, { mode: 0o755 });
    if (setup) {
        await mkdir(path.join(directory, '.propr'));
        await writeFile(path.join(directory, '.propr/setup.sh'), setup);
    }
    const bin = path.join(directory, 'bin');
    await mkdir(bin);
    // CI runners may run tests as root, where the wrapper refuses to run repository
    // commands without su-exec. Report an unprivileged user unless a test supplies its own binaries.
    const isolated = Object.keys(binaries).length > 0;
    for (const [name, script] of Object.entries(isolated ? binaries : { id: 'echo 1000' })) {
        await writeFile(path.join(bin, name), `#!/bin/bash\n${script}\n`, { mode: 0o755 });
    }
    try {
        const result = await executeDockerCommand('/usr/bin/env', [
            `PATH=${isolated ? bin : `${bin}:${process.env.PATH}`}`,
            `PROPR_WORKSPACE=${directory}`, `PROPR_CACHE_DIR=${directory}`, `TRACE=${trace}`, ...env,
            '/bin/bash', '-c', buildWorkflowWrapper(workflow, marker), entrypoint,
        // Generous: this only ends a hung wrapper; tests bound their own commands.
        ], { stdinData: 'the prompt', timeout: 30_000 });
        return { ...result, trace: await readFile(trace, 'utf8').catch(() => '') };
    } finally { await rm(directory, { recursive: true, force: true }); }
}

test('hooks run in order, preserve agent stdin and ignore cleanup failures', async () => {
    const workflow = policy(`hooks:
  after_create: echo create >> "$TRACE"
  before_run: echo before >> "$TRACE"; cat
  after_run: echo after >> "$TRACE"; exit 4
  before_remove: echo remove >> "$TRACE"; exit 5
validation:
  - echo validate >> "$TRACE"; exit 7
  - 'true'
`);
    const result = await runWrapper(workflow);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, 'the prompt');
    assert.equal(result.trace, 'create\nbefore\nagent\nvalidate\nafter\nremove\n');
    assert.match(result.stderr, /marker:validation:0:7/);
    assert.match(result.stderr, /marker:validation:1:0/);
    assert.match(result.stderr, /after_run failed with exit code 4/);
    assert.match(result.stderr, /before_remove failed with exit code 5/);
});

test('failed before_run and explicit after_create abort execution but run before_remove', async () => {
    for (const name of ['before_run', 'after_create']) {
        const result = await runWrapper(policy(`hooks:\n  ${name}: exit 9\n  after_run: echo after >> "$TRACE"\n  before_remove: echo remove >> "$TRACE"`));
        assert.equal(result.exitCode, 9);
        assert.equal(result.trace, 'remove\n');
    }
});

test('enforces the hook timeout and preserves unsuccessful agent exit through cleanup', async () => {
    const workflow = policy(`hooks:
  before_run: sleep 10
  before_remove: echo remove >> "$TRACE"
`);
    workflow.timeoutMs = 50;
    const timedOut = await runWrapper(workflow);
    assert.equal(timedOut.exitCode, 124);
    assert.equal(timedOut.trace, 'remove\n');
    const failedAgent = await runWrapper(policy('hooks:\n  after_run: echo after >> "$TRACE"\n  before_remove: echo remove >> "$TRACE"'), 'exit 6');
    assert.equal(failedAgent.exitCode, 6);
    assert.equal(failedAgent.trace, 'after\nremove\n');
});

test('implicit setup retains nonfatal failures and explicit setup replaces it', async () => {
    const result = await runWrapper(policy(), undefined, 'echo setup >> "$TRACE"; exit 9');
    assert.equal(result.exitCode, 0);
    assert.equal(result.trace, 'setup\nagent\n');
    const explicit = await runWrapper(policy('hooks: { after_create: "true" }'), undefined, 'echo setup >> "$TRACE"');
    assert.equal(explicit.trace, 'agent\n');
});

test('execution context isolates concurrent policies, wraps every agent and adds observed completion results', async () => {
    const makeResult = (logs: string) => ({ success: true, logs, modifiedFiles: [], modelUsed: 'test', executionTimeMs: 1, summary: 'Implemented' });
    await Promise.all(['main', 'release'].map(async baseBranch => {
        const workflow = { ...policy('validation: ["npm test", "npm run lint", "npm run build"]'), baseBranch };
        const result = await executeWithRepositoryWorkflow(workflow, async () => {
            await new Promise(resolve => setTimeout(resolve, 5));
            const context = repositoryWorkflowExecution.getStore()!;
            assert.equal(context.workflow.baseBranch, baseBranch);
            for (const type of ['claude', 'codex', 'opencode', 'antigravity', 'vibe'] as const) {
                const args = wrapDockerRunArgsWithRepoSetup(['run', '--rm', 'image'], 'image', type);
                assert.match(args[args.indexOf('image') + 2], /run_command/);
            }
            observeStderr(`\n${context.marker}:validation:0:0\n${context.marker}:validation:1:124`);
            return makeResult('');
        });
        assert.match(result.repositoryValidation!, /npm test: Passed/);
        assert.match(result.repositoryValidation!, /npm run lint: Timed out/);
        assert.match(result.repositoryValidation!, /npm run build: Not run/);
    }));
    assert.equal(repositoryWorkflowExecution.getStore(), undefined);
    const args = wrapDockerRunArgsWithRepoSetup(['run', '--rm', 'image'], 'image', 'codex');
    assert.doesNotMatch(args[args.indexOf('image') + 2], /run_command/);
});

test('cleanup timeouts are logged without failing the attempt', async () => {
    const workflow = policy('hooks: { after_run: "sleep 10", before_remove: "sleep 10" }');
    workflow.timeoutMs = 30;
    const result = await runWrapper(workflow);
    assert.equal(result.exitCode, 0);
    assert.match(result.stderr, /after_run failed with exit code 124/);
    assert.match(result.stderr, /before_remove failed with exit code 124/);
});

test('a fatal hook cannot become a publishable partial agent timeout', async () => {
    const result = await executeWithRepositoryWorkflow(policy('hooks: { before_run: "sleep 10" }'), async () => {
        const context = repositoryWorkflowExecution.getStore()!;
        observeStderr(`\n${context.marker}:hook:before_run:124`);
        return { success: true, logs: '', modifiedFiles: [], modelUsed: 'test', executionTimeMs: 1, terminationReason: 'timeout' };
    });
    assert.equal(result.success, false);
    assert.equal(result.terminationReason, undefined);
    assert.match(result.error!, /before_run failed with exit code 124/);
});


test('preparation rejects quoting expansion in every hook and validation before agent execution', async () => {
    const command = ': #' + "'".repeat(30_000);
    for (const config of [
        ...['after_create', 'before_run', 'after_run', 'before_remove'].map(name => ({ hooks: { [name]: command } })),
        { validation: [command] },
        { hooks: { before_run: ': #' + "'".repeat(15_000) }, validation: [': #' + "'".repeat(15_000)] },
    ]) {
        const content = JSON.stringify(config);
        assert.ok(Buffer.byteLength(content) < 128 * 1024);
        await assert.rejects(loadRepositoryWorkflow({
            resolveRevision: async () => 'revision',
            readFile: async () => ({ content, sha: 'blob' }),
        }, 'main', { maxParallelTasks: 5 }), /expanded hooks and validation wrapper exceeds 120 KiB; move long commands into repository scripts/);
    }
});

test('expanded wrapper limit counts UTF-8 bytes and overhead, and the largest accepted wrapper executes', async () => {
    const workflow = policy(JSON.stringify({ hooks: { before_run: ': #' } }));
    const overhead = Buffer.byteLength(buildWorkflowWrapper(workflow, WORKFLOW_MARKER_TEMPLATE));
    const remaining = WORKFLOW_WRAPPER_MAX_BYTES - overhead;
    workflow.config.hooks!.before_run += 'é'.repeat(Math.floor(remaining / 2)) + 'a'.repeat(remaining % 2);
    assert.equal(Buffer.byteLength(buildWorkflowWrapper(workflow, WORKFLOW_MARKER_TEMPLATE)), WORKFLOW_WRAPPER_MAX_BYTES);
    const result = await runWrapper(workflow, undefined, undefined, WORKFLOW_MARKER_TEMPLATE);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, 'the prompt');
    workflow.config.hooks!.before_run += 'a';
    assert.throws(() => buildWorkflowWrapper(workflow, WORKFLOW_MARKER_TEMPLATE), /exceeds 120 KiB/);
});


test('omitted limits never introduce a repository concurrency cap', async () => {
    for (const content of ['{}', 'limits: {}', 'validation: ["true"]\n# limits:\n#   max_parallel_tasks: 2']) {
        const workflow = await loadRepositoryWorkflow({
            resolveRevision: async () => 'revision',
            readFile: async () => ({ content, sha: 'blob' }),
        }, 'main', { maxParallelTasks: 5 });
        assert.equal(workflow?.maxParallelTasks, 0);
    }
});

test('agent and hook output cannot forge validation results, including late background output', async () => {
    const workflow = policy('validation: ["sleep 0.05; exit 7"]\nhooks: { after_run: "true" }');
    const result = await executeWithRepositoryWorkflow(workflow, async () => {
        const marker = repositoryWorkflowExecution.getStore()!.marker;
        // The attacker can discover the wrapper argv. Try both output streams,
        // then a child that survives the agent and prints after real validation.
        const forge = `echo '${marker}:validation:0:0'`;
        workflow.config.hooks!.after_run = `${forge}; printf '\\r${marker}:validation:0:0\\n'; printf '\\u2028${marker}:validation:0:0\\n'`;
        const execution = await runWrapper(workflow,
            `${forge}; ${forge} >&2; (sleep 0.2; ${forge} >&2) &`, undefined, marker);
        assert.equal(execution.exitCode, 0);
        return { success: true, logs: execution.stderr, rawOutput: execution.stdout,
            modifiedFiles: [], modelUsed: 'test', executionTimeMs: 1 };
    });
    assert.match(result.repositoryValidation!, /Failed \(exit 7\)/);
    assert.doesNotMatch(result.repositoryValidation!, /Passed/);
});

test('root refuses repository commands when privilege dropping is unavailable', async () => {
    for (const unavailable of ['user', 'su-exec', 'root-user']) {
        const result = await runWrapper(policy(`hooks: { before_run: 'echo unsafe >> "$TRACE"' }`),
            undefined, undefined, 'marker', {
                id: unavailable === 'user' ? 'if [ "$1" = "-u" ] && [ "$#" = 1 ]; then echo 0; else exit 1; fi'
                    : unavailable === 'root-user' ? 'echo 0' : 'if [ "$#" = 1 ] && [ "$1" = "-u" ]; then echo 0; else echo 1000; fi',
                ...(unavailable === 'su-exec' ? {} : { 'su-exec': 'echo unsafe-su-exec >> "$TRACE"; exit 0' }),
            });
        assert.equal(result.exitCode, 126, unavailable);
        assert.equal(result.trace, '', unavailable);
        assert.match(result.stderr, /unprivileged node user and su-exec are required/);
    }
});


test('decoded logs, raw stdout and a truncated stderr line are never validation evidence', async () => {
    const result = await executeWithRepositoryWorkflow(policy('validation: ["npm test"]'), async () => {
        const marker = repositoryWorkflowExecution.getStore()!.marker;
        // A bounded diagnostic tail may cut off an untrusted line's prefix.
        observeStderr(`${marker}:validation:0:0\n`);
        return { success: true, logs: `${marker}:validation:0:0`, rawOutput: `${marker}:validation:0:0`,
            modifiedFiles: [], modelUsed: 'test', executionTimeMs: 1 };
    });
    assert.match(result.repositoryValidation!, /Not run/);
});

test('completed validation and fatal hook results survive later output larger than the diagnostic tail', async () => {
    const workflow = policy('validation: ["exit 3", "big-output"]\nhooks: { before_run: "exit 2", after_run: "big-output", before_remove: "big-output" }');
    const flood = `ProPR command output: ${'x'.repeat(1024)}\n`.repeat(Math.ceil(MAX_PROVIDER_OUTPUT_BYTES / 1024) + 64);
    const result = await executeWithRepositoryWorkflow(workflow, async () => {
        const { marker } = repositoryWorkflowExecution.getStore()!;
        const raw = [`\n${marker}:hook:before_run:2\n`, `\n${marker}:validation:0:3\n`, flood, `\n${marker}:validation:1:0\n`, flood, flood].join('');
        // Arbitrary chunk boundaries, including splits inside the reports.
        const chunks: string[] = [];
        for (let offset = 0; offset < raw.length; offset += 4093) chunks.push(raw.slice(offset, offset + 4093));
        observeStderr(raw, chunks);
        return { success: true, logs: '', modifiedFiles: [], modelUsed: 'test', executionTimeMs: 1 };
    });
    assert.match(result.repositoryValidation!, /exit 3: Failed \(exit 3\)/);
    assert.match(result.repositoryValidation!, /big-output: Passed/);
    assert.equal(result.success, false);
    assert.match(result.error!, /before_run failed with exit code 2/);
});

test('reports split across chunks keep the line-boundary and prefix checks', async () => {
    const workflow = policy('validation: ["a", "b", "c", "d"]');
    const result = await executeWithRepositoryWorkflow(workflow, async () => {
        const { marker } = repositoryWorkflowExecution.getStore()!;
        // Index 0: genuine, split mid-marker. Index 1: CR-terminated. Index 2: a prefixed
        // line whose overlong head is followed by the marker. Index 3: stream start, no LF.
        observeStderr('', [`${marker}:validation:3:0\nnoise\n${marker.slice(0, 9)}`, `${marker.slice(9)}:validation:0:0\n`,
            `${marker}:validation:1:0\r\n`, `ProPR command output: ${'y'.repeat(200)}`, `${marker}:validation:2:0\n`, '']);
        return { success: true, logs: '', modifiedFiles: [], modelUsed: 'test', executionTimeMs: 1 };
    });
    assert.match(result.repositoryValidation!, /- \[1\] a: Passed/);
    assert.match(result.repositoryValidation!, /- \[2\] b: Not run/);
    assert.match(result.repositoryValidation!, /- \[3\] c: Not run/);
    assert.match(result.repositoryValidation!, /- \[4\] d: Not run/);
});

test('a real wrapper keeps the first validation result after a later command floods stderr', async () => {
    // Just past the diagnostic tail is enough; `yes` keeps slow runners well inside the hook timeout.
    const flood = `yes $(printf %0999d 0) | head -c ${MAX_PROVIDER_OUTPUT_BYTES + 64 * 1024}`;
    const workflow = policy(`validation: ["exit 5", "${flood}"]`);
    workflow.timeoutMs = 20_000;
    const result = await executeWithRepositoryWorkflow(workflow, async () => {
        const { marker } = repositoryWorkflowExecution.getStore()!;
        const execution = await runWrapper(workflow, 'cat', undefined, marker);
        assert.doesNotMatch(execution.stderr, new RegExp(`${marker}:validation:0`));
        return { success: true, logs: execution.stderr, modifiedFiles: [], modelUsed: 'test', executionTimeMs: 1 };
    });
    assert.match(result.repositoryValidation!, /exit 5: Failed \(exit 5\)/);
    assert.match(result.repositoryValidation!, /: Passed/);
});

test('validation reports for long accepted commands stay within the completion comment budget', async () => {
    const execute = async (validation: string[], reports: (marker: string) => string) => {
        const content = JSON.stringify({ validation });
        assert.ok(Buffer.byteLength(content) < 128 * 1024);
        const workflow = await loadRepositoryWorkflow({
            resolveRevision: async () => 'revision',
            readFile: async () => ({ content, sha: 'blob' }),
        }, 'main', { maxParallelTasks: 5 });
        return executeWithRepositoryWorkflow(workflow, async () => {
            observeStderr(reports(repositoryWorkflowExecution.getStore()!.marker));
            return { success: true, logs: '', modifiedFiles: [], modelUsed: 'test', executionTimeMs: 1, summary: 'Implemented' };
        });
    };

    const passed = await execute([': #' + 'a'.repeat(75_000)], marker => `\n${marker}:validation:0:0\n`);
    assert.ok(passed.repositoryValidation!.length <= REPOSITORY_VALIDATION_REPORT_MAX_LENGTH);
    assert.match(passed.repositoryValidation!, /^- \[1\] : #a+…: Passed$/m);
    const comment = await generateCompletionComment(passed, { repoOwner: 'o', repoName: 'r', number: 1 });
    assert.ok(comment.length < 65_536, `completion comment has ${comment.length} characters`);
    assert.ok(comment.includes(passed.repositoryValidation!));

    // Failed and not-run commands include the command too; every index and status survives.
    const many = Array.from({ length: 100 }, (_, index) => `: ${index} #${'b'.repeat(1_000)}`);
    const mixed = await execute(many, marker => `\n${many.slice(0, 50).map((_, index) => `${marker}:validation:${index}:${index % 2 ? 7 : 124}`).join('\n')}\n`);
    const lines = mixed.repositoryValidation!.split('\n').slice(2);
    assert.ok(mixed.repositoryValidation!.length <= REPOSITORY_VALIDATION_REPORT_MAX_LENGTH);
    assert.equal(lines.length, 100);
    lines.forEach((line, index) => {
        assert.ok(line.startsWith(`- [${index + 1}] : ${index} #`), line);
        assert.ok(line.endsWith(index >= 50 ? ': Not run (execution ended before validation)' : index % 2 ? ': Failed (exit 7)' : ': Timed out'), line);
    });

    // Shortening happens after redaction, so a secret cut at the boundary cannot leak a prefix.
    const secret = 'x'.repeat(40);
    const redacted = await execute([`: ${'c'.repeat(180)} GITHUB_TOKEN=${secret}`], () => '');
    assert.doesNotMatch(redacted.repositoryValidation!, /xxxx/);
    assert.match(redacted.repositoryValidation!, /: Not run/);
});

test('agent stderr and repository command output carry distinct labels, and Antigravity still finds its own error line', async () => {
    const result = await runWrapper(policy('hooks: { before_run: "echo from-hook >&2" }'), 'echo error: provider quota >&2; cat');
    assert.match(result.stderr, /^ProPR command output: from-hook$/m);
    assert.match(result.stderr, /^ProPR agent stderr: error: provider quota$/m);
    assert.doesNotMatch(result.stderr, /ProPR command output: error: provider quota/);
    // Antigravity's goal stream reads the CLI's failure line from container stderr.
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough() });
    const stream = new AntigravityGoalStream(child as never, { append() {} } as never);
    child.stderr.write(`${result.stderr}ProPR agent stderr: trailing diagnostic\n`);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(stream.errorText, 'error: provider quota');
});

test('read-only containers in the same execution never replace the observed hook and validation results', async () => {
    const result = await executeWithRepositoryWorkflow(policy('validation: ["npm test"]\nhooks: { before_run: "exit 3" }'), async () => {
        const { marker } = repositoryWorkflowExecution.getStore()!;
        observeStderr(`\n${marker}:hook:before_run:3\n${marker}:validation:0:0\n`);
        // A later analysis container runs the wrapper with setup disabled and `exec`s the agent.
        for (const env of [['-e', 'PROPR_REPO_SETUP=0'], ['--env', 'PROPR_REPO_SETUP=0'], ['--env=PROPR_REPO_SETUP=0']]) {
            const readOnly = ['run', '--rm', ...env, 'image', '-lc', `script ${marker}`];
            assert.equal(captureWorkflowMarkers(readOnly), undefined);
            assert.deepEqual(withWorkflowExecutionDeadline('docker', readOnly, 60_000), readOnly);
        }
        return { success: true, logs: '', modifiedFiles: [], modelUsed: 'test', executionTimeMs: 1 };
    });
    assert.equal(result.success, false);
    assert.match(result.error!, /before_run failed with exit code 3/);
    assert.match(result.repositoryValidation!, /npm test: Passed/);
});

test('the transport time limit reaches only this execution\'s docker run wrapper', async () => {
    const workflow = policy('validation: ["npm test"]');
    assert.deepEqual(withWorkflowExecutionDeadline('docker', ['run', 'image'], 60_000), ['run', 'image'], 'no workflow execution');
    await executeWithRepositoryWorkflow(workflow, async () => {
        const { marker } = repositoryWorkflowExecution.getStore()!;
        const args = ['run', '--rm', 'image', '-lc', `script ${marker}`];
        assert.deepEqual(withWorkflowExecutionDeadline('docker', args, 60_000), ['run', '-e', 'PROPR_EXECUTION_TIMEOUT_MS=60000', ...args.slice(1)]);
        assert.deepEqual(withWorkflowExecutionDeadline('/usr/bin/docker', args, 60_000)[2], 'PROPR_EXECUTION_TIMEOUT_MS=60000');
        assert.deepEqual(withWorkflowExecutionDeadline('docker', ['run', 'other-image'], 60_000), ['run', 'other-image']);
        assert.deepEqual(withWorkflowExecutionDeadline('docker', ['exec', ...args.slice(1)], 60_000), ['exec', ...args.slice(1)]);
        return { success: true, logs: '', modifiedFiles: [], modelUsed: 'test', executionTimeMs: 1 };
    });
    await executeWithRepositoryWorkflow(policy('hooks: { before_run: "true" }'), async () => {
        const { marker } = repositoryWorkflowExecution.getStore()!;
        const args = ['run', 'image', marker];
        assert.deepEqual(withWorkflowExecutionDeadline('docker', args, 60_000), args, 'nothing to bound without validation');
        return { success: true, logs: '', modifiedFiles: [], modelUsed: 'test', executionTimeMs: 1 };
    });
});

test('post-agent validation stops before the execution time limit instead of turning a finished agent into a timeout', async () => {
    // 31 s limit minus the 30 s reserve leaves one second for validation.
    const workflow = policy('validation: ["sleep 10", "echo second >> \\"$TRACE\\""]\nhooks: { before_remove: "echo remove >> \\"$TRACE\\"" }');
    workflow.timeoutMs = 4000;
    const reserve = 30 + 4 + 5;
    const started = Date.now();
    const result = await executeWithRepositoryWorkflow(workflow, async () => {
        const { marker } = repositoryWorkflowExecution.getStore()!;
        const execution = await runWrapper(workflow, 'echo agent >> "$TRACE"; exit 0', undefined, marker, {}, [`PROPR_EXECUTION_TIMEOUT_MS=${(reserve + 1) * 1000}`]);
        assert.equal(execution.exitCode, 0, 'the agent exit code is preserved');
        assert.equal(execution.trace, 'agent\nremove\n', 'later commands are skipped, cleanup hooks still run');
        assert.match(execution.stderr, /skipped validation command 2: execution time limit reached/);
        observeStderr(execution.stderr);
        return { success: true, logs: '', modifiedFiles: [], modelUsed: 'test', executionTimeMs: 1 };
    });
    assert.ok(Date.now() - started < 4000, 'the remaining budget, not the per-command timeout, bounded the first command');
    assert.equal(result.success, true);
    assert.match(result.repositoryValidation!, /sleep 10: Timed out/);
    assert.match(result.repositoryValidation!, /second.*: Not run \(execution time limit reached\)/);
    // An exhausted budget skips every command; an absent or malformed limit keeps per-command timeouts only.
    const exhausted = await runWrapper(policy('validation: ["echo ran >> \\"$TRACE\\""]'), 'true', undefined, 'marker', {}, ['PROPR_EXECUTION_TIMEOUT_MS=1000']);
    assert.equal(exhausted.trace, '');
    assert.match(exhausted.stderr, /marker:validation:0:skipped/);
    for (const env of [[], ['PROPR_EXECUTION_TIMEOUT_MS=abc']]) {
        const unbounded = await runWrapper(policy('validation: ["echo ran >> \\"$TRACE\\""]'), 'true', undefined, 'marker', {}, env);
        assert.equal(unbounded.trace, 'ran\n');
    }
});

test('only the wrapper can report a skipped validation command; hooks cannot be skipped', async () => {
    const result = await executeWithRepositoryWorkflow(policy('validation: ["a"]\nhooks: { before_run: "true" }'), async () => {
        const { marker } = repositoryWorkflowExecution.getStore()!;
        observeStderr(`\n${marker}:hook:before_run:skipped\n${marker}:validation:0:skipped\n`);
        return { success: true, logs: '', modifiedFiles: [], modelUsed: 'test', executionTimeMs: 1 };
    });
    assert.equal(result.success, true);
    assert.match(result.repositoryValidation!, /a: Not run \(execution time limit reached\)/);
});

test('a stop reaches the running agent and cleanup hooks still run before the wrapper exits', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'workflow-test-'));
    const trace = path.join(directory, 'trace');
    const entrypoint = path.join(directory, 'agent.sh');
    await writeFile(entrypoint, `#!/bin/bash
sleep 30 & sleeper=$!
trap 'kill "$sleeper"; echo agent-stopped >> "$TRACE"; exit 0' TERM
echo started >> "$TRACE"
wait
`, { mode: 0o755 });
    const bin = path.join(directory, 'bin');
    await mkdir(bin);
    await writeFile(path.join(bin, 'id'), '#!/bin/bash\necho 1000\n', { mode: 0o755 });
    try {
        const workflow = policy('hooks:\n  after_run: echo after >> "$TRACE"\n  before_remove: echo remove >> "$TRACE"');
        const child = spawn('/bin/bash', ['-c', buildWorkflowWrapper(workflow, 'marker'), entrypoint], {
            env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PROPR_WORKSPACE: directory, PROPR_CACHE_DIR: directory, TRACE: trace },
            stdio: ['pipe', 'ignore', 'ignore'],
        });
        const exited = new Promise<number | null>(resolve => child.once('exit', code => resolve(code)));
        while (!(await readFile(trace, 'utf8').catch(() => '')).includes('started')) await new Promise(resolve => setTimeout(resolve, 10));
        // Docker forwards a stop to the wrapper (PID 1); a foreground agent would defer it for 30 s.
        child.kill('SIGTERM');
        assert.equal(await exited, 143);
        assert.equal(await readFile(trace, 'utf8'), 'started\nagent-stopped\nafter\nremove\n');
    } finally { await rm(directory, { recursive: true, force: true }); }
});

test('validation reserves a modest share for cleanup hooks unless their timeout is explicit', () => {
    const reserve = (source: string, timeoutMs = 600_000) => Number(
        /PROPR_EXECUTION_TIMEOUT_MS \/ 1000 - ([0-9]+) \)\)/.exec(buildWorkflowWrapper({ ...policy(source), timeoutMs }, 'marker'))![1]);
    const cleanup = 'validation: [npm test]\nhooks: { after_run: "true", before_remove: "true"';
    assert.equal(reserve('validation: [npm test]'), 30);
    // A 20-30 minute execution limit keeps most of its budget for validation by default.
    assert.equal(reserve(`${cleanup} }`), 30 + 2 * (60 + 5));
    assert.equal(reserve(`${cleanup} }`, 4000), 30 + 2 * (4 + 5));
    assert.equal(reserve(`${cleanup}, timeout_ms: 600000 }`), 30 + 2 * (600 + 5));
    assert.equal(reserve(`${cleanup}, timeout_ms: 600000 }`, 120_000), 30 + 2 * (120 + 5));
});

test('a root wrapper never starts an agent that could stay root, even without repository commands', async () => {
    for (const id of ['echo 0', 'if [ "$1" = "-u" ] && [ "$#" = 1 ]; then echo 0; else exit 1; fi']) {
        const result = await runWrapper(policy('validation: ["echo validate >> \\"$TRACE\\""]'), 'echo agent >> "$TRACE"', undefined, 'marker', {
            id, 'su-exec': 'echo unsafe-su-exec >> "$TRACE"; exit 0',
        });
        assert.equal(result.exitCode, 126, id);
        assert.equal(result.trace, '', id);
        assert.match(result.stderr, /unprivileged node user and su-exec are required/);
    }
});
