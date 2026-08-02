import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

const workerSource = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');
const issueProcessorSource = readFileSync(new URL('../src/jobs/processGitHubIssueJob.ts', import.meta.url), 'utf8');

describe('worker composition contract', () => {
    test('wires every supported job processor into the worker entrypoint', () => {
        for (const processor of [
            'processGitHubIssueJob',
            'processPullRequestCommentJob',
            'processTaskImportJob',
            'processSystemTaskJob',
            'processMergeConflictJob',
        ]) {
            assert.match(workerSource, new RegExp(`import \\{ ${processor} \\}`));
            assert.match(workerSource, new RegExp(`export \\{[^}]*${processor}`));
        }
    });

    test('starts the long-running worker only for direct CLI execution', () => {
        assert.match(workerSource, /if \(import\.meta\.url === `file:\/\/\$\{process\.argv\[1\]\}`\)/);
        assert.match(workerSource, /await startWorker\(options\)/);
    });

    test('keeps matrix dispatch separate from child issue execution', () => {
        assert.match(issueProcessorSource, /if \(!job\.data\.isChildJob\)/);
        assert.match(issueProcessorSource, /return await handleDispatch\(job\)/);
        assert.match(issueProcessorSource, /await initializeJobContext\(job\)/);
    });

    test('enforces label checks before repository mutation', () => {
        const labelCheck = issueProcessorSource.indexOf('checkLabelConditions(currentLabels, context)');
        const clone = issueProcessorSource.indexOf('ensureRepoCloned(');
        assert.ok(labelCheck >= 0);
        assert.ok(clone > labelCheck);
    });
});
