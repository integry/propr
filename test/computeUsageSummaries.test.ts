import assert from 'node:assert/strict';
import { after, test } from 'node:test';

process.env.PROPR_DEMO_MODE = 'true';

const { closeConnection } = await import('@propr/core');
const { generateClaudeLogsComment, generatePRBody } = await import('../src/github/prFormatters.js');
const { buildMetricsSection } = await import('../src/jobs/prCommentMetrics.js');

// The template fallback setting is read from the configuration database.
after(() => closeConnection());

const GIB = 1024 ** 3;
const computeUsage = {
    runtime: 'fly', wallTimeMs: 252_000, cpuSeconds: 182.44, peakMemoryBytes: 1.2 * GIB, avgMemoryBytes: 640 * 1024 ** 2,
    costUsd: 0.03, costSource: 'rate_table' as const,
};
const LINE = 'fly · 4m 12s wall · 182.4 CPU-s · peak 1.2 GiB (avg 640 MiB) · $0.03 (rate table)';

test('the PR comment run summary shows compute usage next to the token cost', async () => {
    const response = { success: true, model: 'gpt-5.6-sol', executionTime: 252_000, output: null, logs: '', modifiedFiles: [], commitMessage: null, summary: null };
    const section = await buildMetricsSection({ ...response, computeUsage }, null, '@integry');
    assert.ok(section.includes(`* **Compute:** ${LINE}\n`), section);
    assert.doesNotMatch(await buildMetricsSection(response, null, '@integry'), /Compute/);
});

test('the PR description and the execution logs comment show compute usage after the API cost', async () => {
    const claudeResult = { success: true, executionTime: 252_000, sessionId: 's', finalResult: { num_turns: 3 }, computeUsage };
    const body = await generatePRBody(3762, 'Record compute usage', 'feat: compute usage', claudeResult);
    assert.ok(body.includes(`- **API cost**: $0\n- **Compute**: ${LINE}\n`), body);
    const comment = await generateClaudeLogsComment(claudeResult, 3762);
    assert.ok(comment.includes(`- **Compute**: ${LINE}\n`), comment);
    assert.doesNotMatch(await generatePRBody(3762, 'x', 'y', { ...claudeResult, computeUsage: undefined }), /Compute/);
});
