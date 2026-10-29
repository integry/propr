import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AGENT_FAILURE_LINE_MAX_CHARS, agentFailureLine } from '../src/agentFailureLine.js';

// The entrypoint preamble and CLI error from the 0.9.0 live E2E model matrix.
function antigravityOutput(model: string): string {
    return [
        'GitHub token detected (using environment variable)',
        'GitHub CLI will use GH_TOKEN environment variable for authentication',
        'Using disposable Antigravity runtime state',
        'Antigravity config directory mounted at /home/node/.gemini',
        'Contents of /home/node/.gemini:',
        'total 8',
        'drwxr-xr-x 2 node node 4096 Oct 28 23:50 .',
        'Antigravity authentication-related configuration found',
        'Running as correct user (UID 1000)',
        `Executing command: /bin/sh -c set -e\nexec agy --dangerously-skip-permissions "$@" --model ${model}`,
        `error: invalid model selection (--model "${model}" --effort ""): model ${model} is not recognized as a known model or custom model in settings`,
        'Available models: Gemini 4 Argon (L/M/H), Gemini 3.8 Flash (L/M/H), Claude Opus 5.5 (L/M/H), Claude Sonnet 5.5 (L/M/H), GPT-OSS 120B (Medium)',
    ].join('\n');
}

test('agentFailureLine names the Antigravity CLI error instead of the entrypoint preamble', () => {
    for (const model of ['gemini-3.7-flash-medium', 'Gemini 3.6 Flash (Medium)']) {
        assert.equal(agentFailureLine(antigravityOutput(model)),
            `error: invalid model selection (--model "${model}" --effort ""): model ${model} is not recognized as a known model or custom model in settings`);
    }
});

test('agentFailureLine picks Node and git error lines and strips terminal colors', () => {
    assert.equal(agentFailureLine('GitHub token detected (using environment variable)\n/app/x.js:3\n  ^\n\nTypeError: boom\n    at main (/app/x.js:3:1)'), 'TypeError: boom');
    assert.equal(agentFailureLine('Switching to node user...\n\u001b[31mfatal: not a git repository\u001b[0m'), 'fatal: not a git repository');
});

test('agentFailureLine falls back to the first non-preamble line and keeps single lines', () => {
    assert.equal(agentFailureLine('Agent authentication failed'), 'Agent authentication failed');
    assert.equal(agentFailureLine('GitHub token detected (using environment variable)\nQuota exhausted for this account\nRetry later'), 'Quota exhausted for this account');
    assert.equal(agentFailureLine('GitHub token detected (using environment variable)\nUsing disposable Antigravity runtime state'), 'Using disposable Antigravity runtime state');
    assert.equal(agentFailureLine(''), '');
});

test('agentFailureLine bounds one line and never returns the rest of the output', () => {
    const long = `error: ${'x'.repeat(AGENT_FAILURE_LINE_MAX_CHARS * 4)}`;
    const line = agentFailureLine(`${long}\n${'raw output\n'.repeat(10_000)}`);
    assert.equal(line, `${long.slice(0, AGENT_FAILURE_LINE_MAX_CHARS)}…`);
    assert.ok(!line.includes('\n'));
});
