import { test } from 'node:test';
import assert from 'node:assert';
import { parseStreamJsonOutput, UsageLimitError } from '../packages/core/src/claude/claudeHelpers.ts';

test('parseStreamJsonOutput propagates UsageLimitError for assistant rate_limit payload', () => {
    const executionResult = {
        stdout: JSON.stringify({
            type: 'assistant',
            error: 'rate_limit',
            message: {
                content: [{ type: 'text', text: 'Limit reached · resets 4pm (UTC) · /upgrade' }]
            }
        }),
        stderr: '',
        exitCode: 1,
        messageTimestamps: new Map<string, string>()
    };

    assert.throws(
        () => parseStreamJsonOutput(executionResult),
        (error: unknown) => error instanceof UsageLimitError
    );
});
