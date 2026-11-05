import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { getModelMaxContextTokens, useSelectedModelMaxTokens } from './useSelectedModelMaxTokens';

const getInstanceCatalog = vi.fn();
vi.mock('../../api/proprApi', () => ({ getInstanceCatalog: () => getInstanceCatalog() }));

describe('getModelMaxContextTokens', () => {
  it('reads the window from agent-prefixed and bare model IDs', () => {
    expect(getModelMaxContextTokens('claude:claude-opus-5')).toBe(1_000_000);
    expect(getModelMaxContextTokens('claude-haiku-4-5-20251001')).toBe(200_000);
  });

  it('returns undefined for empty or unknown models', () => {
    expect(getModelMaxContextTokens(null)).toBeUndefined();
    expect(getModelMaxContextTokens('  ')).toBeUndefined();
    expect(getModelMaxContextTokens('claude:not-a-model')).toBeUndefined();
  });
});

describe('useSelectedModelMaxTokens', () => {
  beforeEach(() => {
    getInstanceCatalog.mockReset();
    getInstanceCatalog.mockResolvedValue({
      agents: [{ alias: 'claude', defaultModel: 'claude-opus-5-5' }],
      defaultAgentAlias: 'claude',
      plannerGenerationModel: null,
    });
  });

  it('uses the instance default model when no model is selected', async () => {
    const { result } = renderHook(() => useSelectedModelMaxTokens(null));
    await waitFor(() => expect(result.current).toBe(1_000_000));
  });

  it('uses the selected model without loading the catalog', () => {
    const { result } = renderHook(() => useSelectedModelMaxTokens('claude:claude-sonnet-4-5-20250929'));
    expect(result.current).toBe(200_000);
    expect(getInstanceCatalog).not.toHaveBeenCalled();
  });

  it('falls back to the preview window for models outside the catalog', () => {
    const { result } = renderHook(() => useSelectedModelMaxTokens('custom:local-model', 128_000));
    expect(result.current).toBe(128_000);
  });
});
