import { renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { useDecoratedRepoOptions } from './useDecoratedRepoOptions';
import type { RepoOption } from '../components/RepositorySelector';

vi.mock('../utils/repoHelpers', () => ({
  fetchEnabledRepos: vi.fn(async () => [
    { name: 'acme/api', enabled: true, baseBranch: 'main', starred: true, iconPath: null, iconRevision: 'main' },
    { name: 'acme/api', enabled: true, baseBranch: 'next', starred: true, iconPath: 'logo.svg', iconRevision: 'abc' },
    { name: 'acme/web', enabled: true, baseBranch: 'main', starred: false, iconPath: null, iconRevision: 'main' },
  ]),
}));

describe('useDecoratedRepoOptions', () => {
  it('adds starred flags and icons while keeping caller fields', async () => {
    const options: RepoOption[] = [
      { name: 'all', enabled: true, displayName: 'All Repos', count: 3 },
      { name: 'acme/api', enabled: true, count: 2 },
      { name: 'acme/web', enabled: true, count: 1 },
      { name: 'acme/old', enabled: false },
    ];
    const { result } = renderHook(() => useDecoratedRepoOptions(options));

    await waitFor(() => expect(result.current[1].starred).toBe(true));
    expect(result.current).toEqual([
      { name: 'all', enabled: true, displayName: 'All Repos', count: 3 },
      { name: 'acme/api', enabled: true, count: 2, starred: true, iconPath: 'logo.svg', iconRevision: 'abc' },
      { name: 'acme/web', enabled: true, count: 1, starred: false, iconPath: null, iconRevision: 'main' },
      { name: 'acme/old', enabled: false },
    ]);
  });

  it('passes through undefined options', () => {
    const { result } = renderHook(() => useDecoratedRepoOptions(undefined));
    expect(result.current).toBeUndefined();
  });
});
