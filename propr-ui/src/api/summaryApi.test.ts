import { afterEach, describe, expect, test, vi } from 'vitest';
import { getDirectoryTree, getIndexingStatus } from './summaryApi';

describe('summary browser API', () => {
  afterEach(() => vi.restoreAllMocks());

  test('includes the configured branch in status and directory-tree requests', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({}));

    await getIndexingStatus('integry', 'propr', 'main');
    await getDirectoryTree('integry', 'propr', 'src/components', 'main');

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      expect.stringContaining('/api/summaries/integry/propr/status?branch=main'),
      expect.stringContaining('/api/summaries/integry/propr/tree/src%2Fcomponents?branch=main'),
    ]);
  });

  test('preserves the default URL when no branch is provided', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({}));

    await getIndexingStatus('integry', 'propr');
    await getDirectoryTree('integry', 'propr');

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      expect.stringContaining('/api/summaries/integry/propr/status'),
      expect.stringContaining('/api/summaries/integry/propr/tree'),
    ]);
    expect(fetchMock.mock.calls.every(([url]) => !String(url).includes('?branch='))).toBe(true);
  });
});
