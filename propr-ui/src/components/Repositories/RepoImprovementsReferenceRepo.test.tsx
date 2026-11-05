import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import RepoActionContainer from './RepoActionContainer';
import { getRepositoriesIndexingStatus, type RepositoryIndexingStatus } from '../../api/repoIndexingApi';
import { generateRepoImprovements } from '../../api/repoImprovementsApi';
vi.mock('../../api/repoIndexingApi', () => ({ getRepositoriesIndexingStatus: vi.fn() }));
vi.mock('../../api/repoImprovementsApi', () => ({ generateRepoImprovements: vi.fn() }));
vi.mock('../../api/proprApi', () => ({ getInstanceCatalog: async () => ({ agents: [] }) }));
vi.mock('../../api/repoChatApi', () => ({ getChatMessages: async () => [] }));
vi.mock('../../contexts/DemoModeContext', () => ({ useDemoMode: () => ({ isDemoMode: false }) }));

const status = (full_name: string, indexing_status: RepositoryIndexingStatus['indexing_status'], branch = 'main') =>
  ({ full_name, branch, indexing_status, last_indexed_at: null, last_indexed_hash: null, last_indexed_commit_message: null });
const renderImprove = () => render(
  <MemoryRouter><RepoActionContainer selectedRepo={{ id: 'repo-1', name: 'acme/web', baseBranch: 'main' }} initialTab="improve" /></MemoryRouter>
);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(generateRepoImprovements).mockResolvedValue({ success: true, suggestions: [] });
});

describe('Improve tab reference repository', () => {
  it('lists other indexed repositories and sends the chosen id with the generate request', async () => {
    vi.mocked(getRepositoriesIndexingStatus).mockResolvedValue({ repositories: [
      status('acme/web', 'completed'),
      status('acme/api', 'completed'),
      status('acme/api', 'completed', 'develop'),
      status('acme/docs', 'indexing'),
      status('acme/broken', 'failed'),
    ] });
    renderImprove();

    expect(await screen.findByText('Reference Repository (Optional)')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Select repository' }));
    const options = screen.getAllByRole('button').map(button => button.textContent);
    expect(options.filter(text => text === 'acme/api')).toHaveLength(1);
    expect(options).toContain('acme/docs');
    expect(options).not.toContain('acme/web');
    expect(options).not.toContain('acme/broken');

    fireEvent.click(screen.getByRole('button', { name: 'acme/api' }));
    fireEvent.click(screen.getByRole('button', { name: /Security/ }));
    fireEvent.click(screen.getByRole('button', { name: /Generate Suggestions/ }));

    await waitFor(() => expect(generateRepoImprovements).toHaveBeenCalledWith(expect.objectContaining({
      repository: 'acme/web',
      categories: ['security'],
      referenceRepoId: 'acme/api',
    })));
  });

  it('hides the selector when no other repository is indexed', async () => {
    vi.mocked(getRepositoriesIndexingStatus).mockResolvedValue({ repositories: [status('acme/web', 'completed')] });
    renderImprove();
    await waitFor(() => expect(getRepositoriesIndexingStatus).toHaveBeenCalled());
    expect(screen.queryByText('Reference Repository (Optional)')).not.toBeInTheDocument();
  });
});
