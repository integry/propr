import { expect, it } from 'vitest';
import { getHistoryDerivedData } from './useHistoryData';
import type { TaskInfo } from './types';

it('uses the execution-reconciled API identity even when legacy history has a default model', () => {
  const result = getHistoryDerivedData([{ state: 'PROCESSING', timestamp: '2026-10-13T12:00:00Z', metadata: { model: 'claude-opus-5-5' } }], { modelName: 'gpt-6-astra' } as TaskInfo);
  expect(result.modelName).toBe('GPT-6 Astra');
});
it('uses the latest recorded model when task identity is unavailable', () => {
  const result = getHistoryDerivedData(['claude-opus-5-5', 'gpt-6-astra'].map(model => ({ state: 'PROCESSING', timestamp: '2026-10-13T12:00:00Z', metadata: { model } })), null);
  expect(result.modelName).toBe('GPT-6 Astra');
});
it('keeps unresolved routing unknown', () => {
  expect(getHistoryDerivedData([], null).modelName).toBe('Unknown Model');
});

const execution = (session: string, state: string, timestamp: string) => ({
  state, timestamp, promptPath: `/api/execution/${session}/prompt`, logsPath: `/api/execution/${session}/logs`,
});

it('opens the successful retry, not the failed first attempt, after an automatic retry', () => {
  const { historyItemWithPaths } = getHistoryDerivedData([
    execution('failed-attempt', 'PROCESSING', '2026-10-17T21:00:00Z'),
    { state: 'FAILED', timestamp: '2026-10-17T21:01:00Z' },
    { state: 'PENDING', timestamp: '2026-10-17T21:01:05Z' },
    execution('successful-retry', 'PROCESSING', '2026-10-17T21:01:10Z'),
    { state: 'COMPLETED', timestamp: '2026-10-17T21:05:00Z' },
  ], null);
  expect(historyItemWithPaths?.logsPath).toBe('/api/execution/successful-retry/logs');
  expect(historyItemWithPaths?.promptPath).toBe('/api/execution/successful-retry/prompt');
});
it('opens the only execution when later steps carry no paths', () => {
  const { historyItemWithPaths } = getHistoryDerivedData([
    { state: 'PENDING', timestamp: '2026-10-17T21:00:00Z' },
    execution('only', 'PROCESSING', '2026-10-17T21:00:05Z'),
    { state: 'COMPLETED', timestamp: '2026-10-17T21:05:00Z' },
  ], null);
  expect(historyItemWithPaths?.logsPath).toBe('/api/execution/only/logs');
});
it('offers no prompt or logs when no step has an execution', () => {
  expect(getHistoryDerivedData([{ state: 'PENDING', timestamp: '2026-10-17T21:00:00Z' }, { state: 'FAILED', timestamp: '2026-10-17T21:01:00Z' }], null).historyItemWithPaths).toBeUndefined();
  expect(getHistoryDerivedData([], null).historyItemWithPaths).toBeUndefined();
});
