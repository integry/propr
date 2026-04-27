import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import PlansPage from './PlansPage';
import type { PaginatedDraftsResponse, RepositoriesResponse } from '../api/proprApi';
import { getDrafts, getDraftRepositories } from '../api/proprApi';

vi.mock('../hooks/useDocumentTitle', () => ({
  useDocumentTitle: vi.fn(),
}));

vi.mock('../api/proprApi', () => ({
  getDrafts: vi.fn(),
  getDraftRepositories: vi.fn(),
  deleteDraft: vi.fn(),
  abortGeneration: vi.fn(),
}));

vi.mock('../contexts/useSocket', () => ({
  useSocket: () => ({
    isConnected: false,
    onDraftUpdate: vi.fn(),
  }),
}));

vi.mock('./PlansPageComponents', () => ({
  EmptyState: () => <div>empty state</div>,
  PlansTable: () => <div>plans table</div>,
  PaginationControls: () => null,
}));

const mockGetDrafts = vi.mocked(getDrafts);
const mockGetDraftRepositories = vi.mocked(getDraftRepositories);

describe('PlansPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders repository filter counts and respects the repository query param', async () => {
    const repositoriesResponse: RepositoriesResponse = {
      repositories: [
        { repo: 'integry/propr', count: 3 },
        { repo: 'integry/agent', count: 1 },
      ],
      total: 4,
    };
    const draftsResponse: PaginatedDraftsResponse = {
      drafts: [{
        draft_id: 'draft-1',
        repository: 'integry/propr',
        initial_prompt: 'Test draft',
        status: 'draft',
        updated_at: '2026-04-27T00:00:00Z',
        created_at: '2026-04-27T00:00:00Z',
      }],
      total: 1,
      page: 1,
      limit: 20,
      hasMore: false,
    };
    mockGetDraftRepositories.mockResolvedValue(repositoriesResponse);
    mockGetDrafts.mockResolvedValue(draftsResponse);

    render(
      <MemoryRouter initialEntries={['/plans?repository=integry/propr']}>
        <Routes>
          <Route path="/plans" element={<PlansPage />} />
        </Routes>
      </MemoryRouter>
    );

    await waitFor(() => expect(mockGetDrafts).toHaveBeenCalledWith(expect.objectContaining({
      repository: 'integry/propr',
    })));

    const trigger = screen.getByRole('button', { name: /propr/i });
    expect(trigger.textContent).toContain('integry');
    expect(trigger.textContent).toContain('propr');
    expect(trigger.textContent).toContain('3');

    fireEvent.click(trigger);

    expect(screen.getByText('All Repos')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /All Repos/ }).textContent).toContain('4');
    expect(screen.getByRole('button', { name: /agent/ }).textContent).toContain('1');
  });
});
