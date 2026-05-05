import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { redactSecrets, redactSerializableValue, createLogFiles, generateCompletionComment } from '../packages/core/src/utils/github/logFiles.js';

test('redactSecrets replaces GitHub personal access tokens', () => {
    const input = 'token is ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn';
    const result = redactSecrets(input);
    assert.ok(!result.includes('ghp_'));
    assert.ok(result.includes('[REDACTED_GITHUB_TOKEN]'));
});

test('redactSecrets replaces GitHub fine-grained tokens', () => {
    const input = 'github_pat_ABCDEFGHIJKLMNOPQRSTUV1234567890';
    const result = redactSecrets(input);
    assert.ok(!result.includes('github_pat_'));
    assert.ok(result.includes('[REDACTED_GITHUB_TOKEN]'));
});

test('redactSecrets replaces AWS access keys', () => {
    const input = 'key is AKIAIOSFODNN7EXAMPLE';
    const result = redactSecrets(input);
    assert.ok(!result.includes('AKIAIOSFODNN7EXAMPLE'));
    assert.ok(result.includes('[REDACTED_AWS_ACCESS_KEY]'));
});

test('redactSecrets replaces Bearer tokens', () => {
    const input = 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    const result = redactSecrets(input);
    assert.ok(!result.includes('eyJhbGciOiJ'));
    assert.ok(result.includes('Bearer [REDACTED_BEARER_TOKEN]'));
});

test('redactSecrets leaves normal text unchanged', () => {
    const input = 'This is a normal log message with no secrets';
    assert.strictEqual(redactSecrets(input), input);
});

test('redactSecrets handles multiple secrets in one string', () => {
    const input = 'token1=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn key=AKIAIOSFODNN7EXAMPLE';
    const result = redactSecrets(input);
    assert.ok(result.includes('[REDACTED_GITHUB_TOKEN]'));
    assert.ok(result.includes('[REDACTED_AWS_ACCESS_KEY]'));
});

test('redactSerializableValue redacts strings within nested objects', () => {
    const input = {
        message: {
            content: [{ text: 'Found token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn in env' }]
        }
    };
    const result = redactSerializableValue(input);
    assert.ok(!JSON.stringify(result).includes('ghp_'));
    assert.ok(JSON.stringify(result).includes('[REDACTED_GITHUB_TOKEN]'));
});

test('redactSerializableValue handles arrays', () => {
    const input = [
        { text: 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn' },
        { text: 'safe text' }
    ];
    const result = redactSerializableValue(input) as Array<{ text: string }>;
    assert.ok(!JSON.stringify(result).includes('ghp_'));
    assert.strictEqual(result[1].text, 'safe text');
});

test('redactSerializableValue preserves non-string values', () => {
    const input = { count: 42, flag: true, data: null };
    const result = redactSerializableValue(input);
    assert.deepStrictEqual(result, input);
});

test('redactSecrets replaces OpenRouter API keys', () => {
    const input = 'key is sk-or-v1-' + 'a'.repeat(64);
    const result = redactSecrets(input);
    assert.ok(!result.includes('sk-or-v1-'));
    assert.ok(result.includes('[REDACTED_OPENROUTER_KEY]'));
});

test('redactSecrets replaces Stripe secret keys', () => {
    const input = 'sk_live_' + 'a'.repeat(24);
    const result = redactSecrets(input);
    assert.ok(!result.includes('sk_live_'));
    assert.ok(result.includes('[REDACTED_STRIPE_SECRET_KEY]'));
});

test('redactSecrets replaces Anthropic API keys', () => {
    const input = 'sk-ant-' + 'a'.repeat(32);
    const result = redactSecrets(input);
    assert.ok(!result.includes('sk-ant-'));
    assert.ok(result.includes('[REDACTED_ANTHROPIC_KEY]'));
});

test('redactSecrets replaces Slack tokens', () => {
    const input = 'xoxb-1234567890-abcdefghij';
    const result = redactSecrets(input);
    assert.ok(!result.includes('xoxb-'));
    assert.ok(result.includes('[REDACTED_SLACK_TOKEN]'));
});

test('redactSecrets replaces AWS temporary access keys (ASIA prefix)', () => {
    const input = 'key is ASIAIOSTEMPKEY7EXAMP';
    const result = redactSecrets(input);
    assert.ok(!result.includes('ASIAIOSTEMPKEY7EXAMP'));
    assert.ok(result.includes('[REDACTED_AWS_ACCESS_KEY]'));
});

test('redactSecrets replaces AWS secret access keys', () => {
    const input = 'aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY1';
    const result = redactSecrets(input);
    assert.ok(!result.includes('wJalrXUtnFEMI'));
    assert.ok(result.includes('[REDACTED_AWS_SECRET_KEY]'));
});

test('redactSecrets replaces generic secret assignment patterns', () => {
    const input = 'SECRET_KEY="abcdefghijklmnopqrstuvwxyz1234"';
    const result = redactSecrets(input);
    assert.ok(!result.includes('abcdefghijklmnopqrstuvwxyz1234'));
    assert.ok(result.includes('[REDACTED_SECRET]'));
});

test('redactSecrets replaces generic API_KEY assignment patterns', () => {
    const input = "API_KEY='someLongSecretValue12345678'";
    const result = redactSecrets(input);
    assert.ok(!result.includes('someLongSecretValue12345678'));
    assert.ok(result.includes('[REDACTED_SECRET]'));
});

test('redactSerializableValue redacts secrets in conversation log structure used by createLogFiles', () => {
    const conversationLog = [
        {
            type: 'assistant',
            message: {
                content: [{ text: 'I found the token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn in the config' }]
            }
        },
        {
            type: 'assistant',
            message: {
                content: [{ text: 'The AWS key is AKIAIOSFODNN7EXAMPLE' }]
            }
        }
    ];
    const redacted = redactSerializableValue(conversationLog);
    const serialized = JSON.stringify(redacted);
    assert.ok(!serialized.includes('ghp_'), 'GitHub token should be redacted');
    assert.ok(!serialized.includes('AKIAIOSFODNN7EXAMPLE'), 'AWS key should be redacted');
    assert.ok(serialized.includes('[REDACTED_GITHUB_TOKEN]'));
    assert.ok(serialized.includes('[REDACTED_AWS_ACCESS_KEY]'));
});

// --- Broader AWS secret key format tests (Finding 3) ---

test('redactSecrets replaces AWS secret keys with JSON-style "SecretAccessKey" label', () => {
    const input = '"SecretAccessKey": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY1"';
    const result = redactSecrets(input);
    assert.ok(!result.includes('wJalrXUtnFEMI'), 'AWS secret should be redacted in JSON context');
    assert.ok(result.includes('[REDACTED_AWS_SECRET_KEY]'));
});

test('redactSecrets replaces AWS secret keys with camelCase "secretAccessKey" label', () => {
    const input = '"secretAccessKey": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY1"';
    const result = redactSecrets(input);
    assert.ok(!result.includes('wJalrXUtnFEMI'), 'AWS secret should be redacted in camelCase JSON context');
    assert.ok(result.includes('[REDACTED_AWS_SECRET_KEY]'));
});

test('redactSecrets replaces AWS secret keys with AWS_SECRET_KEY env var', () => {
    const input = 'AWS_SECRET_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY1';
    const result = redactSecrets(input);
    assert.ok(!result.includes('wJalrXUtnFEMI'), 'AWS secret should be redacted with AWS_SECRET_KEY prefix');
    assert.ok(result.includes('[REDACTED_AWS_SECRET_KEY]'));
});

test('redactSecrets replaces SendGrid API keys', () => {
    const input = 'SG.abcdefghijklmnopqrstuv.ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq';
    const result = redactSecrets(input);
    assert.ok(!result.includes('SG.'), 'SendGrid key should be redacted');
    assert.ok(result.includes('[REDACTED_SENDGRID_KEY]'));
});

test('redactSecrets replaces Google API keys', () => {
    const input = 'AIzaSyA1234567890abcdefghijklmnopqrstuvw';
    const result = redactSecrets(input);
    assert.ok(!result.includes('AIzaSy'), 'Google API key should be redacted');
    assert.ok(result.includes('[REDACTED_GOOGLE_API_KEY]'));
});

test('redactSecrets replaces OpenAI project keys (longer variant)', () => {
    const input = 'sk-proj-' + 'X'.repeat(80);
    const result = redactSecrets(input);
    assert.ok(!result.includes('sk-proj-'), 'OpenAI project key should be redacted');
    assert.ok(result.includes('[REDACTED_OPENAI_KEY]'));
});

// --- End-to-end tests for createLogFiles (Finding 2) ---

test('createLogFiles writes redacted secrets to the JSON conversation log file', async (t) => {
    const githubToken = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn';
    const awsKey = 'AKIAIOSFODNN7EXAMPLE';
    const claudeResult = {
        success: true,
        conversationLog: [
            {
                type: 'assistant',
                message: {
                    content: [{ text: `Found token ${githubToken} and key ${awsKey}` }]
                }
            }
        ],
        rawOutput: `Output containing ${githubToken}`
    };
    const issueRef = { number: 9999, repoOwner: 'test-owner', repoName: 'test-repo' };

    const logFiles = await createLogFiles(claudeResult, issueRef);

    // Failure-safe cleanup: runs even if assertions throw
    t.after(async () => {
        if (logFiles.conversation) await fs.promises.unlink(logFiles.conversation).catch(() => {});
        if (logFiles.output) await fs.promises.unlink(logFiles.output).catch(() => {});
    });

    // Verify conversation JSON file is redacted
    assert.ok(logFiles.conversation, 'Conversation log file should be created');
    const jsonContent = await fs.promises.readFile(logFiles.conversation, 'utf-8');
    assert.ok(!jsonContent.includes(githubToken), 'GitHub token must not appear in persisted JSON');
    assert.ok(!jsonContent.includes(awsKey), 'AWS key must not appear in persisted JSON');
    assert.ok(jsonContent.includes('[REDACTED_GITHUB_TOKEN]'), 'Redaction placeholder should be present in JSON');
    assert.ok(jsonContent.includes('[REDACTED_AWS_ACCESS_KEY]'), 'AWS redaction placeholder should be present in JSON');

    // Verify raw output text file is redacted
    assert.ok(logFiles.output, 'Output log file should be created');
    const txtContent = await fs.promises.readFile(logFiles.output, 'utf-8');
    assert.ok(!txtContent.includes(githubToken), 'GitHub token must not appear in persisted text output');
    assert.ok(txtContent.includes('[REDACTED_GITHUB_TOKEN]'), 'Redaction placeholder should be present in text output');
});

test('createLogFiles writes redacted Bearer tokens to the text output file', async (t) => {
    const bearerToken = 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    const claudeResult = {
        success: true,
        rawOutput: `Authorization: ${bearerToken}`
    };
    const issueRef = { number: 9998, repoOwner: 'test-owner', repoName: 'test-repo' };

    const logFiles = await createLogFiles(claudeResult, issueRef);

    // Failure-safe cleanup: runs even if assertions throw
    t.after(async () => {
        if (logFiles.output) await fs.promises.unlink(logFiles.output).catch(() => {});
    });

    assert.ok(logFiles.output, 'Output log file should be created');
    const txtContent = await fs.promises.readFile(logFiles.output, 'utf-8');
    assert.ok(!txtContent.includes('eyJhbGciOiJ'), 'Bearer token must not appear in persisted text output');
    assert.ok(txtContent.includes('Bearer [REDACTED_BEARER_TOKEN]'), 'Redacted bearer placeholder should be present');
});

// --- Lowercase bearer token tests (Review finding 1) ---

test('redactSecrets replaces lowercase "bearer" tokens and preserves casing', () => {
    const input = 'authorization: bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    const result = redactSecrets(input);
    assert.ok(!result.includes('eyJhbGciOiJ'), 'Lowercase bearer token should be redacted');
    assert.ok(result.includes('bearer [REDACTED_BEARER_TOKEN]'), 'Original lowercase "bearer" casing should be preserved');
});

test('redactSecrets replaces mixed-case "BEARER" tokens and preserves casing', () => {
    const input = 'Authorization: BEARER eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    const result = redactSecrets(input);
    assert.ok(!result.includes('eyJhbGciOiJ'), 'Uppercase BEARER token should be redacted');
    assert.ok(result.includes('BEARER [REDACTED_BEARER_TOKEN]'), 'Original uppercase "BEARER" casing should be preserved');
});

// --- toJSON / Date serialization preservation tests (Review finding 2) ---

test('redactSerializableValue preserves Date serialization via toJSON', () => {
    const date = new Date('2026-01-15T10:30:00.000Z');
    const input = { createdAt: date, message: 'hello' };
    const result = redactSerializableValue(input) as Record<string, unknown>;
    // Date.toJSON() returns an ISO string; redactSerializableValue should preserve that
    assert.strictEqual(result.createdAt, '2026-01-15T10:30:00.000Z');
    assert.strictEqual(result.message, 'hello');
    // Verify it matches what JSON.stringify would produce
    const directJson = JSON.parse(JSON.stringify(input));
    assert.strictEqual(result.createdAt, directJson.createdAt);
});

test('redactSerializableValue preserves custom toJSON and redacts secrets within', () => {
    const obj = {
        toJSON() {
            return { key: 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn' };
        }
    };
    const result = redactSerializableValue(obj) as Record<string, unknown>;
    assert.ok(!JSON.stringify(result).includes('ghp_'), 'Secret inside toJSON output should be redacted');
    assert.ok(JSON.stringify(result).includes('[REDACTED_GITHUB_TOKEN]'));
});

test('redactSerializableValue passes the correct key argument to toJSON()', () => {
    const receivedKeys: string[] = [];
    const parent = {
        child: {
            toJSON(key: string) {
                receivedKeys.push(key);
                return `serialized-${key}`;
            }
        }
    };
    redactSerializableValue(parent);
    assert.deepStrictEqual(receivedKeys, ['child'], 'toJSON should receive the property name as key');
});

test('redactSerializableValue passes empty string key for root toJSON()', () => {
    const receivedKeys: string[] = [];
    const root = {
        toJSON(key: string) {
            receivedKeys.push(key);
            return 'root-value';
        }
    };
    redactSerializableValue(root);
    assert.deepStrictEqual(receivedKeys, [''], 'Root toJSON should receive empty string as key');
});

test('redactSerializableValue passes array index as key for toJSON() inside arrays', () => {
    const receivedKeys: string[] = [];
    const arr = [
        {
            toJSON(key: string) {
                receivedKeys.push(key);
                return 'item';
            }
        }
    ];
    redactSerializableValue(arr);
    assert.deepStrictEqual(receivedKeys, ['0'], 'toJSON inside array should receive the string index as key');
});

// --- False-positive tests (should NOT redact) ---

test('redactSecrets should not redact the word "token" in ordinary prose', () => {
    const input = 'The token count was 1500 tokens. Each token represents a piece of text.';
    assert.strictEqual(redactSecrets(input), input);
});

test('redactSecrets should not redact "Bearer" without a following token value', () => {
    const input = 'The Bearer authentication scheme is defined in RFC 6750.';
    assert.strictEqual(redactSecrets(input), input);
});

test('redactSecrets should not redact short strings that look like key prefixes', () => {
    const input = 'Use key-value pairs for configuration.';
    assert.strictEqual(redactSecrets(input), input);
});

test('redactSecrets should not redact words like "access_key" in documentation text', () => {
    const input = 'The access_key field is required for authentication. Set the token in your config.';
    assert.strictEqual(redactSecrets(input), input);
});

test('redactSecrets should not redact "sk-" followed by short strings', () => {
    const input = 'The variable sk-foo is used internally.';
    assert.strictEqual(redactSecrets(input), input);
});

test('redactSecrets should not redact "SECRET_KEY" without an assignment', () => {
    const input = 'Make sure SECRET_KEY is set in your environment.';
    assert.strictEqual(redactSecrets(input), input);
});

// --- Plain sk- key detection test (Finding 2) ---

test('redactSecrets does not false-positive on short sk- identifiers', () => {
    // A plain "sk-" + 32 chars should NOT be redacted — it could be a non-secret identifier
    const input = 'sk-' + 'a'.repeat(32);
    assert.strictEqual(redactSecrets(input), input, 'Short sk- string should not be redacted');
});

test('redactSecrets redacts OpenAI legacy keys with T3BlbkFJ marker', () => {
    const input = 'sk-' + 'a'.repeat(20) + 'T3BlbkFJ' + 'b'.repeat(20);
    const result = redactSecrets(input);
    assert.ok(!result.includes('T3BlbkFJ'), 'Legacy OpenAI key should be redacted');
    assert.ok(result.includes('[REDACTED_OPENAI_KEY]'));
});

test('redactSecrets redacts OpenAI project keys (sk-proj-)', () => {
    const input = 'sk-proj-' + 'a'.repeat(50);
    const result = redactSecrets(input);
    assert.ok(!result.includes('sk-proj-'), 'OpenAI project key should be redacted');
    assert.ok(result.includes('[REDACTED_OPENAI_KEY]'));
});

// --- End-to-end test for generateCompletionComment (Review warning: comment redaction) ---

test('generateCompletionComment redacts secrets in summary, conversation preview, and raw output', async (t) => {
    const githubToken = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn';
    const bearerToken = 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    const awsKey = 'AKIAIOSFODNN7EXAMPLE';

    const claudeResult = {
        success: true,
        executionTime: 5000,
        model: 'claude-opus-4-6',
        // Intentionally omit sessionId/conversationId to avoid constructing a
        // real Redis client inside createLogFiles — keeps this a deterministic
        // unit test with no external dependencies.
        summary: `Completed task. Used token ${githubToken} to push changes.`,
        conversationLog: [
            {
                type: 'assistant',
                message: {
                    content: [{ text: `I used ${bearerToken} and ${awsKey} to authenticate.` }]
                }
            }
        ],
        rawOutput: `Raw output with secret ${githubToken}`,
        tokenUsage: { input_tokens: 1000, output_tokens: 500 }
    };

    const issueRef = { number: 7777, repoOwner: 'test-owner', repoName: 'test-repo' };

    // Failure-safe cleanup: runs even if assertions throw
    t.after(async () => {
        const os = await import('os');
        const path = await import('path');
        const logDir = path.join(os.tmpdir(), 'claude-logs');
        const entries = await fs.promises.readdir(logDir).catch(() => [] as string[]);
        for (const entry of entries) {
            if (entry.startsWith('issue-7777-')) {
                await fs.promises.unlink(path.join(logDir, entry)).catch(() => {});
            }
        }
    });

    const comment = await generateCompletionComment(claudeResult, issueRef);

    // Secrets must not appear anywhere in the final comment
    assert.ok(!comment.includes(githubToken), 'GitHub token must not leak into the comment body');
    assert.ok(!comment.includes('eyJhbGciOiJ'), 'Bearer JWT must not leak into the comment body');
    assert.ok(!comment.includes(awsKey), 'AWS access key must not leak into the comment body');

    // Redaction placeholders should be present
    assert.ok(comment.includes('[REDACTED_GITHUB_TOKEN]'), 'GitHub redaction placeholder should appear in comment');
    assert.ok(comment.includes('[REDACTED_BEARER_TOKEN]'), 'Bearer redaction placeholder should appear in comment');
    assert.ok(comment.includes('[REDACTED_AWS_ACCESS_KEY]'), 'AWS redaction placeholder should appear in comment');
});

// --- Vendor-specific false-positive boundary tests ---

test('redactSecrets should not redact Stripe publishable key prefix in prose', () => {
    const input = 'Use pk_test_ prefix for publishable test keys and pk_live_ for production.';
    assert.strictEqual(redactSecrets(input), input);
});

test('redactSecrets should not redact "rk_live_" followed by short strings in documentation', () => {
    const input = 'Restricted keys start with rk_live_ or rk_test_ prefixes.';
    assert.strictEqual(redactSecrets(input), input);
});

test('redactSecrets should not redact "key-" followed by short strings', () => {
    const input = 'Use key-value pairs or key-based lookups.';
    assert.strictEqual(redactSecrets(input), input);
});

test('redactSecrets should not redact short sk- identifiers that are not real keys', () => {
    const input = 'The sk-short variable is just a name.';
    assert.strictEqual(redactSecrets(input), input);
});

test('redactSecrets correctly redacts a real Stripe publishable key', () => {
    const input = 'pk_live_' + 'A'.repeat(24);
    const result = redactSecrets(input);
    assert.ok(!result.includes('pk_live_'), 'Stripe publishable key should be redacted');
    assert.ok(result.includes('[REDACTED_STRIPE_PUBLISHABLE_KEY]'));
});

test('redactSecrets correctly redacts a real Stripe restricted key', () => {
    const input = 'rk_test_' + 'B'.repeat(24);
    const result = redactSecrets(input);
    assert.ok(!result.includes('rk_test_'), 'Stripe restricted key should be redacted');
    assert.ok(result.includes('[REDACTED_STRIPE_RESTRICTED_KEY]'));
});

test('redactSecrets correctly redacts a real Mailgun key', () => {
    const input = 'key-' + 'a'.repeat(32);
    const result = redactSecrets(input);
    assert.ok(!result.includes('key-aaa'), 'Mailgun key should be redacted');
    assert.ok(result.includes('[REDACTED_MAILGUN_KEY]'));
});

// --- Case-insensitive equivalence tests (prove no casing bypasses redaction) ---

test('redactSecrets redacts BEARER in all-caps', () => {
    const input = 'Authorization: BEARER eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    const result = redactSecrets(input);
    assert.ok(!result.includes('eyJhbGciOiJ'), 'All-caps BEARER token value must be redacted');
    assert.ok(result.includes('BEARER [REDACTED_BEARER_TOKEN]'));
});

test('redactSecrets redacts lowercase secret assignment patterns', () => {
    const input = 'password="abcdefghijklmnopqrstuvwxyz1234"';
    const result = redactSecrets(input);
    assert.ok(!result.includes('abcdefghijklmnopqrstuvwxyz1234'), 'Lowercase password assignment must be redacted');
    assert.ok(result.includes('[REDACTED_SECRET]'));
});

test('redactSecrets redacts mixed-case secret assignment patterns', () => {
    const input = 'Api_Key="someLongSecretValue1234567890ab"';
    const result = redactSecrets(input);
    assert.ok(!result.includes('someLongSecretValue1234567890ab'), 'Mixed-case Api_Key assignment must be redacted');
    assert.ok(result.includes('[REDACTED_SECRET]'));
});

// --- Generic *_TOKEN variable tests (Review finding: missing TOKEN patterns) ---

test('redactSecrets redacts GITHUB_TOKEN assignment', () => {
    const input = 'GITHUB_TOKEN=ghx_someLongTokenValue1234567890abc';
    const result = redactSecrets(input);
    assert.ok(!result.includes('ghx_someLongTokenValue1234567890abc'), 'GITHUB_TOKEN value should be redacted');
    assert.ok(result.includes('[REDACTED_SECRET]'));
});

test('redactSecrets redacts NPM_TOKEN assignment', () => {
    const input = 'NPM_TOKEN="npm_abcdefghijklmnopqrstuvwxyz"';
    const result = redactSecrets(input);
    assert.ok(!result.includes('npm_abcdefghijklmnopqrstuvwxyz'), 'NPM_TOKEN value should be redacted');
    assert.ok(result.includes('[REDACTED_SECRET]'));
});

test('redactSecrets redacts SLACK_TOKEN assignment', () => {
    const input = 'SLACK_TOKEN=some_long_slack_token_value_1234';
    const result = redactSecrets(input);
    assert.ok(!result.includes('some_long_slack_token_value_1234'), 'SLACK_TOKEN value should be redacted');
    assert.ok(result.includes('[REDACTED_SECRET]'));
});

test('redactSecrets redacts CI_JOB_TOKEN assignment', () => {
    const input = 'CI_JOB_TOKEN=abcdefghijklmnopqrstuvwxyz1234';
    const result = redactSecrets(input);
    assert.ok(!result.includes('abcdefghijklmnopqrstuvwxyz1234'), 'CI_JOB_TOKEN value should be redacted');
    assert.ok(result.includes('[REDACTED_SECRET]'));
});

test('redactSecrets redacts plain TOKEN assignment', () => {
    const input = 'TOKEN="mySecretTokenValue12345678901234"';
    const result = redactSecrets(input);
    assert.ok(!result.includes('mySecretTokenValue12345678901234'), 'Plain TOKEN value should be redacted');
    assert.ok(result.includes('[REDACTED_SECRET]'));
});

test('redactSecrets redacts CLIENT_SECRET assignment', () => {
    const input = 'CLIENT_SECRET=abcdefghijklmnopqrstuvwxyz1234';
    const result = redactSecrets(input);
    assert.ok(!result.includes('abcdefghijklmnopqrstuvwxyz1234'), 'CLIENT_SECRET value should be redacted');
    assert.ok(result.includes('[REDACTED_SECRET]'));
});

// --- Cyclic object handling test (Review finding: stack overflow on cycles) ---

test('redactSerializableValue handles cyclic objects without stack overflow', () => {
    const obj: Record<string, unknown> = { name: 'test', secret: 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn' };
    obj.self = obj; // create cycle
    const result = redactSerializableValue(obj) as Record<string, unknown>;
    assert.strictEqual(result.self, '[Circular]', 'Cyclic reference should be replaced with [Circular]');
    assert.ok(!(result.secret as string).includes('ghp_'), 'Secrets should still be redacted in cyclic objects');
    assert.ok((result.secret as string).includes('[REDACTED_GITHUB_TOKEN]'));
});

test('redactSerializableValue handles cyclic arrays without stack overflow', () => {
    const arr: unknown[] = ['ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn'];
    arr.push(arr); // create cycle
    const result = redactSerializableValue(arr) as unknown[];
    assert.strictEqual(result[1], '[Circular]', 'Cyclic array reference should be replaced with [Circular]');
    assert.ok(!(result[0] as string).includes('ghp_'), 'Secrets should still be redacted');
});

test('redactSecrets redacts secrets regardless of surrounding text with no known prefixes', () => {
    // This input contains no literal prefix strings from the old SECRET_PREFIXES list
    // but should still be redacted via the case-insensitive generic pattern
    const input = 'MY_PASSWORD="VeryLongSecretPassword12345678"';
    const result = redactSecrets(input);
    assert.ok(!result.includes('VeryLongSecretPassword12345678'), 'Generic PASSWORD assignment must be redacted even without fast-path prefix');
    assert.ok(result.includes('[REDACTED_SECRET]'));
});
