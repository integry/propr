import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { McpError } from '../mcp/config.js';
import { classifyError, isPathLikeDetailKey, redactDetails, toToolErrorResult } from '../mcp/errorEnvelope.js';

test('McpError keeps legacy defaults and round-trips optional envelope fields', () => {
  assert.deepEqual(new McpError('STALE_HEAD', 'Pull request head changed.', 409).toEnvelope(), {
    code: 'STALE_HEAD', message: 'Pull request head changed.', stage: null, retryable: false, status: 409,
  });
  assert.deepEqual(new McpError('CHECKS_PENDING', 'Wait for checks.', 409, {
    stage: 'precondition', retryable: true, details: { pending: 2 },
  }).toEnvelope(), {
    code: 'CHECKS_PENDING', message: 'Wait for checks.', stage: 'precondition', retryable: true, status: 409, details: { pending: 2 },
  });
});

test('validation, transport and database failures receive stable classifications', () => {
  let zodError: unknown;
  try { z.object({ repository: z.string() }).parse({}); } catch (error) { zodError = error; }
  const invalid = classifyError(zodError, { sideEffectsPossible: false });
  assert.equal(invalid.code, 'INVALID_INPUT');
  assert.equal(invalid.stage, 'validation');
  assert.deepEqual((invalid.details?.issues as Array<{ path: unknown }>)[0].path, ['repository']);
  assert.equal(classifyError(Object.assign(new Error('late'), { code: 'ETIMEDOUT' }), { sideEffectsPossible: false }).code, 'UPSTREAM_TIMEOUT');
  assert.equal(classifyError(Object.assign(new Error('busy'), { code: 'SQLITE_BUSY' }), { sideEffectsPossible: false }).code, 'DATABASE_BUSY');
});

test('GitHub rejections retain safe detail and mutation uncertainty', () => {
  const mcpToken = 'propr_mcp_abcdefghijklmnopqrstuvwxyz';
  const github = Object.assign(new Error('request failed'), {
    name: 'HttpError', status: 422,
    response: { status: 422, headers: {}, data: { message: `Validation Failed for ${mcpToken}`, errors: [{ message: 'Reference does not exist' }] } },
  });
  const read = classifyError(github, { sideEffectsPossible: false });
  assert.equal(read.code, 'GITHUB_REJECTED');
  assert.equal(read.message, 'Validation Failed for [REDACTED]: Reference does not exist');
  const mutation = classifyError(github, { sideEffectsPossible: true });
  assert.equal(mutation.code, 'OUTCOME_UNKNOWN');
  assert.equal(mutation.retryable, false);
  assert.equal(mutation.stage, 'github');
  assert.deepEqual(mutation.cause, { code: 'GITHUB_REJECTED', message: 'Validation Failed for [REDACTED]: Reference does not exist' });
  const result = toToolErrorResult(read);
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, 'GITHUB_REJECTED');
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  assert.ok(!result.content[0].text.includes(mcpToken));
  assert.ok(!JSON.stringify(result.structuredContent).includes(mcpToken));
});

test('all envelope strings and details redact credentials and local paths', () => {
  const input = [
    'ghp_abcdefghijklmnopqrstuvwxyz123456',
    'github_pat_abcdefghijklmnopqrstuvwxyz_123456',
    'Bearer abc.def',
    'https://x-access-token:abc@github.com/acme/repo.git',
    'https://example.test/file?X-Amz-Signature=abc&token=def',
    'pia_mcp_abcdefghijklmnopqrstuvwxyz',
    'propr_mcp_abcdefghijklmnopqrstuvwxyz',
  ].join(' ');
  const details = redactDetails({ message: `${input} failed at /home/user/private/source.ts`, accessToken: 'never-visible', nested: { password: 'never-visible' }, path: '/home/user/private/file.txt' });
  const envelope = new McpError('SAFE_ERROR', input, 400, { details }).toEnvelope();
  const serialized = JSON.stringify(toToolErrorResult(envelope));
  for (const secret of ['ghp_', 'github_pat_', 'Bearer abc', 'x-access-token:abc', 'X-Amz-Signature=abc', 'token=def', 'pia_mcp_', 'propr_mcp_', 'accessToken', 'never-visible', '/home/user']) {
    assert.ok(!serialized.includes(secret), secret);
  }
  assert.equal(envelope.details?.path, 'file.txt');
  assert.match(String(envelope.details?.message), /source\.ts/);
});

test('whole-string basename reduction applies only to path-like detail keys', () => {
  for (const key of ['path', 'file', 'logsPath', 'prompt_path', 'source-file', 'files', 'directories', 'repoRoot', 'cwd', 'workspace', 'workDir']) {
    assert.equal(isPathLikeDetailKey(key), true, key);
  }
  for (const key of ['reason', 'error', 'title', 'message', 'progress', 'targetState', 'profile', 'value']) {
    assert.equal(isPathLikeDetailKey(key), false, key);
  }

  const details = redactDetails({
    path: '/home/user/private/file.txt',
    files: ['/home/user/private/a.ts', 'C:\\Users\\me\\b.ts', 'relative.ts'],
    root: '/',
    reason: '/merge was rejected because /var/lib/propr/state/plan.json is stale',
    error: '/fix S26 S27 S28 failed',
    title: '/docs cleanup',
    targetState: { state: '/tmp/queue/pending', taskTitle: '/api tidy' },
    nested: { logsPath: '/var/log/propr/task.log' },
  });
  assert.equal(details.path, 'file.txt');
  assert.deepEqual(details.files, ['a.ts', 'b.ts', 'relative.ts']);
  assert.equal(details.root, '[REDACTED_PATH]');
  assert.equal(details.reason, '/merge was rejected because plan.json is stale');
  assert.equal(details.error, '/fix S26 S27 S28 failed');
  assert.equal(details.title, '/docs cleanup');
  assert.deepEqual(details.targetState, { state: 'pending', taskTitle: '/api tidy' });
  assert.deepEqual(details.nested, { logsPath: 'task.log' });
});
