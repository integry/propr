import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { usePromptData } from './usePromptData';
import { useLogFilesData } from './useLogFilesData';

const pending = vi.hoisted(() => ({ prompt: [] as ((body: string) => void)[], logs: [] as ((body: unknown) => void)[] }));
vi.mock('../../api/proprApi', () => ({
  fetchPrompt: vi.fn(() => new Promise<string>(resolve => pending.prompt.push(resolve))),
  fetchLogFiles: vi.fn(() => new Promise(resolve => pending.logs.push(resolve))),
  fetchLogFile: vi.fn(async () => ''),
}));

describe('task viewer requests', () => {
  beforeEach(() => { pending.prompt.length = 0; pending.logs.length = 0; });

  test('a closed Prompt viewer stays closed when its pending response arrives', async () => {
    const { result } = renderHook(() => usePromptData());
    act(() => { void result.current.fetchPrompt('/prompt'); });
    act(() => result.current.closePrompt());
    await act(async () => pending.prompt.shift()!(JSON.stringify({ prompt: 'late' })));
    expect(result.current.selectedPrompt).toBeNull();
    expect(result.current.loadingPrompt).toBe(false);
  });

  test('only the latest Prompt request opens the viewer', async () => {
    const { result } = renderHook(() => usePromptData());
    act(() => { void result.current.fetchPrompt('/older'); });
    act(() => { void result.current.fetchPrompt('/newer'); });
    const [older, newer] = pending.prompt.splice(0);
    await act(async () => newer(JSON.stringify({ prompt: 'newer' })));
    await act(async () => older(JSON.stringify({ prompt: 'older' })));
    expect(result.current.selectedPrompt).toEqual({ prompt: 'newer' });
  });

  test('a closed Logs viewer stays closed when its pending response arrives', async () => {
    const { result } = renderHook(() => useLogFilesData());
    act(() => { void result.current.fetchLogFilesData('/logs'); });
    act(() => result.current.closeLogFiles());
    await act(async () => pending.logs.shift()!({ sessionId: 's', files: { conversation: '/var/log/a.json' } }));
    expect(result.current.logFiles).toBeNull();
    expect(result.current.loadingLogFile).toBe(false);
  });
});
