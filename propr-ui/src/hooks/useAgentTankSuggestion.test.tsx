import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getAgentTankStatus } from '../api/revertApi';
import { useAgentTankSuggestion } from './useAgentTankSuggestion';

vi.mock('../api/revertApi', () => ({
  getAgentTankStatus: vi.fn(),
}));

const mockGetAgentTankStatus = vi.mocked(getAgentTankStatus);

describe('useAgentTankSuggestion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('clears an administrator-only suggestion immediately after demotion', async () => {
    mockGetAgentTankStatus.mockResolvedValue({ available: false } as never);
    const { result, rerender } = renderHook(
      ({ canManage }) => useAgentTankSuggestion(canManage),
      { initialProps: { canManage: true } }
    );
    await waitFor(() => expect(result.current.showSuggestion).toBe(true));

    rerender({ canManage: false });

    await waitFor(() => expect(result.current.showSuggestion).toBe(false));
  });

  it('does not restore the suggestion when an in-flight check finishes after demotion', async () => {
    let resolveStatus: ((status: { available: boolean }) => void) | undefined;
    mockGetAgentTankStatus.mockReturnValue(new Promise(resolve => { resolveStatus = resolve; }) as never);
    const { result, rerender } = renderHook(
      ({ canManage }) => useAgentTankSuggestion(canManage),
      { initialProps: { canManage: true } }
    );

    rerender({ canManage: false });
    await act(async () => { resolveStatus?.({ available: false }); });

    expect(result.current.showSuggestion).toBe(false);
  });
});
