import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createContainerExecutionId } from '../packages/core/src/agents/impl/utils/containerExecutionId.js';
import {
  buildCodexDockerArgs,
  DEFAULT_CODEX_STREAM_IDLE_TIMEOUT_MS,
  DEFAULT_CODEX_STREAM_MAX_RETRIES,
  DEFAULT_CODEX_STREAM_TRANSPORT,
  resolveCodexStreamConfig,
} from '../packages/core/src/agents/impl/utils/codexDockerArgsBuilder.js';
import { closeConnection } from '../packages/core/src/db/connection.js';
import {
  DEFAULT_CONTEXT_ANALYSIS_TIMEOUT_MS,
  resolveContextAnalysisTimeoutMs,
} from '../packages/core/src/services/relevance/contextAnalysisConfig.js';

after(async () => {
  await closeConnection();
});

describe('context analysis runtime safeguards', () => {
  const codexConfig = {
    id: 'codex-test',
    type: 'codex' as const,
    alias: 'codex',
    enabled: true,
    dockerImage: 'propr/agent:test',
    configPath: '/tmp/codex-config',
    supportedModels: ['gpt-5.6-sol'],
  };

  const codexParams = {
    worktreePath: '/tmp/review-worktree',
    githubToken: '',
    issueNumber: 0,
    taskId: 'pr-comments-batch-integry-mcptest-268-006379edfa5d',
    executionType: 'pr-review',
    readOnlyWorkspace: true,
  };

  function codexConfigOverrides(args: string[]): string[] {
    return args.flatMap((arg, index) => arg === '--config' ? [args[index + 1]] : []);
  }

  test('creates distinct fallback container IDs for parallel calls in the same millisecond', (t) => {
    t.mock.method(Date, 'now', () => 1_785_825_895_919);

    const first = createContainerExecutionId();
    const second = createContainerExecutionId();

    assert.notStrictEqual(first, second);
    assert.match(first, /^[a-z0-9]+-[a-f0-9]{8}$/);
    assert.match(second, /^[a-z0-9]+-[a-f0-9]{8}$/);
  });

  test('keeps the task suffix while making every task-backed execution unique', () => {
    const first = createContainerExecutionId('first-command-79edfa5d');
    const second = createContainerExecutionId('second-command-79edfa5d');

    assert.notStrictEqual(first, second);
    assert.match(first, /^79edfa5d-[a-f0-9]{8}$/);
    assert.match(second, /^79edfa5d-[a-f0-9]{8}$/);
  });

  test('gives repeated Codex review attempts distinct Docker names', () => {
    const firstArgs = buildCodexDockerArgs(codexConfig, codexParams);
    const secondArgs = buildCodexDockerArgs(codexConfig, codexParams);
    const firstName = firstArgs[firstArgs.indexOf('--name') + 1];
    const secondName = secondArgs[secondArgs.indexOf('--name') + 1];

    assert.match(firstName, /^codex-pr-review-79edfa5d-[a-f0-9]{8}$/);
    assert.match(secondName, /^codex-pr-review-79edfa5d-[a-f0-9]{8}$/);
    assert.notStrictEqual(firstName, secondName);
  });

  test('uses a WebSocket-capable provider with a thirty-minute idle timeout by default', () => {
    assert.deepEqual(resolveCodexStreamConfig({}), {
      transport: DEFAULT_CODEX_STREAM_TRANSPORT,
      idleTimeoutMs: DEFAULT_CODEX_STREAM_IDLE_TIMEOUT_MS,
      maxRetries: DEFAULT_CODEX_STREAM_MAX_RETRIES,
    });

    const args = buildCodexDockerArgs({
      ...codexConfig,
      envVars: {
        CODEX_STREAM_TRANSPORT: DEFAULT_CODEX_STREAM_TRANSPORT,
        CODEX_STREAM_IDLE_TIMEOUT_MS: String(DEFAULT_CODEX_STREAM_IDLE_TIMEOUT_MS),
        CODEX_STREAM_MAX_RETRIES: String(DEFAULT_CODEX_STREAM_MAX_RETRIES),
      },
    }, codexParams);
    const overrides = codexConfigOverrides(args);

    assert.ok(overrides.includes('model_provider="propr_openai"'));
    assert.ok(overrides.includes('model_providers.propr_openai.requires_openai_auth=true'));
    assert.ok(overrides.includes('model_providers.propr_openai.supports_websockets=true'));
    assert.ok(overrides.includes('model_providers.propr_openai.stream_idle_timeout_ms=1800000'));
    assert.ok(overrides.includes('model_providers.propr_openai.stream_max_retries=5'));
  });

  test('allows WebSocket tuning and per-execution overrides', () => {
    const args = buildCodexDockerArgs({
      ...codexConfig,
      envVars: {
        CODEX_STREAM_TRANSPORT: 'sse',
        CODEX_STREAM_IDLE_TIMEOUT_MS: 'invalid',
        CODEX_STREAM_MAX_RETRIES: '-1',
      },
    }, {
      ...codexParams,
      environment: {
        CODEX_STREAM_TRANSPORT: 'websocket',
        CODEX_STREAM_IDLE_TIMEOUT_MS: '7200000',
        CODEX_STREAM_MAX_RETRIES: '9',
      },
    });
    const overrides = codexConfigOverrides(args);

    assert.ok(overrides.includes('model_providers.propr_openai.supports_websockets=true'));
    assert.ok(overrides.includes('model_providers.propr_openai.stream_idle_timeout_ms=7200000'));
    assert.ok(overrides.includes('model_providers.propr_openai.stream_max_retries=9'));
  });

  test('allows SSE when the environment cannot carry WebSockets', () => {
    const args = buildCodexDockerArgs({
      ...codexConfig,
      envVars: { CODEX_STREAM_TRANSPORT: 'sse' },
    }, codexParams);
    const overrides = codexConfigOverrides(args);

    assert.ok(overrides.includes('model_providers.propr_openai.supports_websockets=false'));
  });

  test('can inherit a user-managed Codex provider without injecting ProPR overrides', () => {
    const args = buildCodexDockerArgs({
      ...codexConfig,
      envVars: { CODEX_STREAM_TRANSPORT: 'inherit' },
    }, codexParams);
    const overrides = codexConfigOverrides(args);

    assert.ok(!overrides.some(value => value.startsWith('model_provider=')));
    assert.ok(!overrides.some(value => value.startsWith('model_providers.propr_openai.')));
  });

  test('rejects invalid stream timeout and retry values', () => {
    assert.deepEqual(resolveCodexStreamConfig({
      CODEX_STREAM_TRANSPORT: 'invalid',
      CODEX_STREAM_IDLE_TIMEOUT_MS: '0',
      CODEX_STREAM_MAX_RETRIES: '-1',
    }), {
      transport: DEFAULT_CODEX_STREAM_TRANSPORT,
      idleTimeoutMs: DEFAULT_CODEX_STREAM_IDLE_TIMEOUT_MS,
      maxRetries: DEFAULT_CODEX_STREAM_MAX_RETRIES,
    });
  });

  test('defaults context analysis to sixty minutes', () => {
    assert.strictEqual(DEFAULT_CONTEXT_ANALYSIS_TIMEOUT_MS, 3_600_000);
    assert.strictEqual(resolveContextAnalysisTimeoutMs(undefined), 3_600_000);
  });

  test('accepts a positive timeout override and rejects invalid values', () => {
    assert.strictEqual(resolveContextAnalysisTimeoutMs('7200000'), 7_200_000);
    assert.strictEqual(resolveContextAnalysisTimeoutMs('0'), DEFAULT_CONTEXT_ANALYSIS_TIMEOUT_MS);
    assert.strictEqual(resolveContextAnalysisTimeoutMs('not-a-number'), DEFAULT_CONTEXT_ANALYSIS_TIMEOUT_MS);
  });
});
