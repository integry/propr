import { afterEach, describe, expect, test, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import SummaryBrowserPage from './SummaryBrowserPage';
import { getAvailableGithubRepos, getInstanceCatalog } from '../api/proprApi';
import { getIndexingStatus } from '../api/summaryApi';

vi.mock('../api/proprApi', () => ({
  getAvailableGithubRepos: vi.fn(),
  getInstanceCatalog: vi.fn(),
}));

vi.mock('../api/summaryApi', () => ({
  getDirectoryTree: vi.fn(),
  getIndexingStatus: vi.fn(),
}));

const mockedGetAvailableGithubRepos = vi.mocked(getAvailableGithubRepos);
const mockedGetInstanceCatalog = vi.mocked(getInstanceCatalog);
const mockedGetIndexingStatus = vi.mocked(getIndexingStatus);

afterEach(() => vi.clearAllMocks());

function renderPage(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/summaries" element={<SummaryBrowserPage />} />
        <Route path="/summaries/:owner/:repo" element={<SummaryBrowserPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('SummaryBrowserPage branch navigation', () => {
  test('uses the configured branch for a standalone repository route', async () => {
    mockedGetAvailableGithubRepos.mockResolvedValue({ repos: [] });
    mockedGetInstanceCatalog.mockResolvedValue({
      agents: [],
      repositories: [{ name: 'integry/propr', enabled: true, baseBranch: 'release/2026' }],
    });
    mockedGetIndexingStatus.mockResolvedValue({
      repository: 'integry/propr',
      indexed: false,
      indexingStatus: 'idle',
      totalEntries: 0,
      fileCount: 0,
      directoryCount: 0,
      lastIndexedAt: null,
      lastIndexedHash: null,
      lastIndexedCommitMessage: null,
    });

    renderPage('/summaries/integry/propr');

    await waitFor(() => expect(mockedGetIndexingStatus)
      .toHaveBeenCalledWith('integry', 'propr', 'release/2026'));
  });

  test('keeps an explicitly requested branch ahead of configured repository settings', async () => {
    mockedGetAvailableGithubRepos.mockResolvedValue({ repos: [] });
    mockedGetInstanceCatalog.mockResolvedValue({
      agents: [],
      repositories: [{ name: 'integry/propr', enabled: true, baseBranch: 'main' }],
    });
    mockedGetIndexingStatus.mockResolvedValue({
      repository: 'integry/propr',
      indexed: false,
      indexingStatus: 'idle',
      totalEntries: 0,
      fileCount: 0,
      directoryCount: 0,
      lastIndexedAt: null,
      lastIndexedHash: null,
      lastIndexedCommitMessage: null,
    });

    renderPage('/summaries/integry/propr?branch=feature%2Fwith%20space');

    await waitFor(() => expect(mockedGetIndexingStatus)
      .toHaveBeenCalledWith('integry', 'propr', 'feature/with space'));
  });
});
