import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseRepositoryWorkflow } from '../src/workflow/repositoryWorkflow.js';
import type { ResolvedRepositoryWorkflow } from '../src/workflow/repositoryWorkflow.js';
import { captureWorkflowMarkers, executeWithRepositoryWorkflow, markWorkflowWrapperBuilt, repositoryWorkflowExecution } from '../src/workflow/workflowExecution.js';
import {
    buildRepositoryValidation, buildRepositoryValidationReport, renderRepositoryValidationReport, REPOSITORY_VALIDATION_REPORT_MAX_LENGTH,
} from '../src/workflow/repositoryValidationResult.js';

const policy = (source: string): ResolvedRepositoryWorkflow => ({
    revision: 'base-commit', fileRevision: 'blob', baseBranch: 'main', config: parseRepositoryWorkflow(source), timeoutMs: 1000, maxParallelTasks: 2,
});
const agentResult = () => ({ success: true, logs: '', modifiedFiles: [], modelUsed: 'test', executionTimeMs: 1 });

/** Runs the workflow with the given wrapper reports captured from the transport, as the Docker executor would. */
function run(workflow: ResolvedRepositoryWorkflow, reports: (marker: string) => string, { capture = true } = {}) {
    return executeWithRepositoryWorkflow(workflow, async () => {
        const { marker } = repositoryWorkflowExecution.getStore()!;
        markWorkflowWrapperBuilt([marker]);
        if (capture) captureWorkflowMarkers([marker])!.finish(reports(marker));
        return agentResult();
    });
}

test('each wrapper report maps to one closed status and the report renders from it', async () => {
    const commands = ['npm test', 'exit 7', 'sleep 9', 'kill -9 $$', 'exit 124', 'npm run late', 'npm run never'];
    const workflow = policy(`validation: ${JSON.stringify(commands)}`);
    const reports = ['0', '7', 'timeout', '137', '124', 'skipped'];
    const result = await run(workflow, marker => `\n${reports.map((code, index) => `${marker}:validation:${index}:${code}`).join('\n')}\n`);
    assert.deepEqual(result.repositoryValidationResult, {
        overall: 'failed',
        commands: [
            { index: 0, command: 'npm test', status: 'passed', verified: true },
            { index: 1, command: 'exit 7', status: 'failed', exitCode: 7, verified: true },
            { index: 2, command: 'sleep 9', status: 'timed_out', verified: true },
            { index: 3, command: 'kill -9 $$', status: 'killed', exitCode: 137, verified: true },
            { index: 4, command: 'exit 124', status: 'failed', exitCode: 124, verified: true },
            { index: 5, command: 'npm run late', status: 'not_run', reason: 'time_limit_reached', verified: true },
            { index: 6, command: 'npm run never', status: 'not_run', reason: 'execution_ended', verified: true },
        ],
    });
    // Byte-identical to the report rendered from free-form statuses before the structured result existed.
    assert.equal(result.repositoryValidation, buildRepositoryValidationReport([
        { command: 'npm test', status: 'Passed' }, { command: 'exit 7', status: 'Failed (exit 7)' }, { command: 'sleep 9', status: 'Timed out' },
        { command: 'kill -9 $$', status: 'Killed (exit 137)' }, { command: 'exit 124', status: 'Failed (exit 124)' },
        { command: 'npm run late', status: 'Not run (execution time limit reached)' }, { command: 'npm run never', status: 'Not run (execution ended before validation)' },
    ]));
    assert.equal(renderRepositoryValidationReport(result.repositoryValidationResult!), result.repositoryValidation);
});

test('unverified and unobserved reports keep their qualifiers in both forms', async () => {
    const workflow = policy('validation: ["npm test", "npm run lint"]');
    const unverified = await run(workflow, marker => `\n${marker}:unverified\n${marker}:validation:0:0\n`);
    assert.deepEqual(unverified.repositoryValidationResult!.commands.map(entry => [entry.status, entry.verified]), [['passed', false], ['not_run', false]]);
    assert.equal(unverified.repositoryValidationResult!.overall, 'incomplete');
    assert.equal(unverified.repositoryValidation, '### Repository validation\n\n'
        + '- [1] npm test: Passed (unverified: container wrapper was not running as root)\n'
        + '- [2] npm run lint: Not run (execution ended before validation) (unverified: container wrapper was not running as root)');

    const unobserved = await run(workflow, () => '', { capture: false });
    assert.deepEqual(unobserved.repositoryValidationResult!.commands.map(entry => entry.status), ['not_observed', 'not_observed']);
    assert.equal(unobserved.repositoryValidationResult!.overall, 'incomplete');
    assert.match(unobserved.repositoryValidation!, /\[1\] npm test: Not observed \(agent transport did not capture container output\)$/m);

    const passed = await run(workflow, marker => `\n${marker}:validation:0:0\n${marker}:validation:1:0\n`);
    assert.equal(passed.repositoryValidationResult!.overall, 'passed');
});

test('stored commands are the redacted, bounded labels shown in the report', () => {
    const secret = 'x'.repeat(40);
    const commands = [`: ${'c'.repeat(180)} GITHUB_TOKEN=${secret}`, ': #' + 'a'.repeat(75_000), '  npm\n  test  '];
    const built = buildRepositoryValidation(commands, { validation: new Map([[1, '0'], [2, '0']]) }, false)!;
    assert.doesNotMatch(JSON.stringify(built.result), /xxxx/);
    assert.ok(built.result.commands[1].command.length <= 200);
    assert.ok(built.result.commands[1].command.endsWith('…'));
    assert.equal(built.result.commands[2].command, 'npm test');
    assert.ok(built.report.length <= REPOSITORY_VALIDATION_REPORT_MAX_LENGTH);
    assert.equal(built.report, buildRepositoryValidationReport(commands.map((command, index) => ({ command, status: index ? 'Passed' : 'Not run (execution ended before validation)' }))));
});

test('a run without a workflow or without validation commands carries no result', async () => {
    assert.equal(buildRepositoryValidation([], { validation: new Map() }, false), undefined);
    const none = await executeWithRepositoryWorkflow(undefined, async () => agentResult());
    assert.equal('repositoryValidationResult' in none, false);
    const hooksOnly = await run(policy('hooks: { before_run: "true" }'), marker => `\n${marker}:hook:before_run:0\n`);
    assert.equal('repositoryValidationResult' in hooksOnly, false);
    assert.equal('repositoryValidation' in hooksOnly, false);
});
