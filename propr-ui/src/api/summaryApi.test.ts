import { afterEach, describe, expect, test, vi } from 'vitest';
import { getDirectoryTree, getFullTree, getIndexingStatus, getPathSummary } from './summaryApi';

describe('summary browser API', () => {
  afterEach(() => vi.restoreAllMocks());

  test('passes an encoded branch to status, tree, path-summary, and full-tree requests', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ entries: [] }));
    const branch = 'release/2026 Q1';

    await getIndexingStatus('integry', 'propr', branch);
    await getDirectoryTree('integry', 'propr', 'src/components', branch);
    await getPathSummary('integry', 'propr', 'src/components/App.tsx', branch);
    await getFullTree('integry', 'propr', 0, branch);

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      expect.stringContaining('/api/summaries/integry/propr/status?branch=release%2F2026%20Q1'),
      expect.stringContaining('/api/summaries/integry/propr/tree/src%2Fcomponents?branch=release%2F2026%20Q1'),
      expect.stringContaining('/api/summaries/integry/propr/summary/src%2Fcomponents%2FApp.tsx?branch=release%2F2026%20Q1'),
      expect.stringContaining('/api/summaries/integry/propr/tree?branch=release%2F2026%20Q1'),
    ]);
  });

  test('keeps the legacy URL when no branch is provided', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ entries: [] }));

    await getIndexingStatus('integry', 'propr');
    await getDirectoryTree('integry', 'propr');
    await getPathSummary('integry', 'propr', 'README.md');

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      expect.stringContaining('/api/summaries/integry/propr/status'),
      expect.stringContaining('/api/summaries/integry/propr/tree'),
      expect.stringContaining('/api/summaries/integry/propr/summary/README.md'),
    ]);
    expect(fetchMock.mock.calls.every(([url]) => !String(url).includes('?branch='))).toBe(true);
  });
});
