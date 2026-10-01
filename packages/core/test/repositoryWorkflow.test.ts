import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { createRequire } from 'node:module';
import { parseRepositoryWorkflow, loadRepositoryWorkflow, refineWorkflowPreviews, repositoryWorkflowPrompt } from '../src/workflow/repositoryWorkflow.js';
import type { ResolvedRepositoryWorkflow } from '../src/workflow/repositoryWorkflow.js';
import { buildWorkflowWrapper, executeWithRepositoryWorkflow, repositoryWorkflowExecution } from '../src/workflow/workflowExecution.js';
import { wrapDockerRunArgsWithRepoSetup } from '../src/claude/docker/repoSetupWrapper.js';

const policy = (source = '{}'): ResolvedRepositoryWorkflow => ({
    revision: 'base-commit', fileRevision: 'blob', baseBranch: 'release', config: parseRepositoryWorkflow(source),
    timeoutMs: 1000, maxParallelTasks: 2,
});

test('rejects malformed and privilege-expanding policy with actionable field errors', () => {
    for (const source of [
        '', 'null', '[]', 'hooks: nope', 'hooks: { before_run: 1 }', 'hooks: { timeout_ms: 0 }',
        'hooks: { before_run: echo, before_run: other }', 'validation: npm test', 'validation: [null]',
        'previews: { types: [audio] }', 'previews: { types: [image, image] }',
        'limits: { max_parallel_tasks: 1.5 }', 'limits: { max_parallel_tasks: 0 }',
        'credentials: secret', 'network: host', 'mounts: [/etc]', 'hooks: { env: {} }',
        'instructions: /etc/passwd', 'instructions: ../secrets', 'instructions: .propr/../secrets',
        'instructions: "C:\\\\secrets"', 'instructions: ./test.md', 'instructions: a//b',
        'instructions: !custom file.md', 'validation: [&a npm, *a]',
    ]) assert.throws(() => parseRepositoryWorkflow(source), /Invalid .propr\/workflow.yml/, source);
    assert.deepEqual(parseRepositoryWorkflow('{}'), {});
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

async function runWrapper(workflow: ResolvedRepositoryWorkflow, agent = 'echo agent >> "$TRACE"; cat', setup?: string) {
    const directory = await mkdtemp(path.join(tmpdir(), 'workflow-test-'));
    const entrypoint = path.join(directory, 'agent.sh');
    const trace = path.join(directory, 'trace');
    await writeFile(entrypoint, `#!/bin/bash\n${agent}\n`, { mode: 0o755 });
    if (setup) {
        await mkdir(path.join(directory, '.propr'));
        await writeFile(path.join(directory, '.propr/setup.sh'), setup);
    }
    try {
        const result = await execa('/bin/bash', ['-c', buildWorkflowWrapper(workflow, 'marker'), entrypoint], {
            env: { PROPR_WORKSPACE: directory, PROPR_CACHE_DIR: directory, TRACE: trace },
            input: 'the prompt', reject: false, timeout: 5000,
        });
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
            return makeResult(`${context.marker}:validation:0:0\n${context.marker}:validation:1:124`);
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
    const result = await executeWithRepositoryWorkflow(policy('hooks: { before_run: "sleep 10" }'), async () => ({
        success: true, logs: `${repositoryWorkflowExecution.getStore()!.marker}:hook:before_run:124`,
        modifiedFiles: [], modelUsed: 'test', executionTimeMs: 1, terminationReason: 'timeout',
    }));
    assert.equal(result.success, false);
    assert.equal(result.terminationReason, undefined);
    assert.match(result.error!, /before_run failed with exit code 124/);
});
