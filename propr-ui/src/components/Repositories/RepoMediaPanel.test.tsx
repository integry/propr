import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import RepoActionContainer from './RepoActionContainer';
import { getRepositoryMedia } from '../../api/repositoryMediaApi';
vi.mock('../../api/repositoryMediaApi', () => ({ getRepositoryMedia: vi.fn() }));
vi.mock('../../api/proprApi', () => ({ getInstanceCatalog: async () => ({ agents: [] }) }));
vi.mock('../../api/repoChatApi', () => ({ getChatMessages: async () => [] }));
vi.mock('../../contexts/DemoModeContext', () => ({ useDemoMode: () => ({ isDemoMode: false }) }));
const repo = { id: 'repo-1', name: 'acme/web', visualPreview: { enabled: true } };
const media = [{ title: 'Dashboard preview', type: 'image' as const, url: 'https://github.com/user-attachments/assets/dashboard' }];
const renderPanel = (enabled = true) => render(<RepoActionContainer selectedRepo={{ ...repo, visualPreview: { enabled } }} initialTab="media" settingsContent={<p>Repository settings</p>} />, { wrapper: MemoryRouter });

beforeEach(() => { vi.clearAllMocks(); vi.mocked(getRepositoryMedia).mockResolvedValue({ previews: [], nextOffset: null, unavailable: false }); });
describe('repository Media tab', () => {
  it.each([false, undefined])('omits tab and requests for disabled/legacy repositories (%s)', enabled => {
    render(<RepoActionContainer selectedRepo={{ ...repo, visualPreview: enabled === undefined ? undefined : { enabled } }} initialTab="media" settingsContent={<p>Repository settings</p>} />, { wrapper: MemoryRouter });
    expect(screen.queryByRole('button', { name: 'Media' })).not.toBeInTheDocument();
    expect(screen.getByText('Repository settings')).toBeInTheDocument();
    expect(getRepositoryMedia).not.toHaveBeenCalled();
  });
  it('shows loading then empty state only for enabled repositories', async () => {
    let finish!: (value: Awaited<ReturnType<typeof getRepositoryMedia>>) => void;
    vi.mocked(getRepositoryMedia).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    renderPanel();
    expect(screen.getByRole('button', { name: 'Media' })).toBeInTheDocument();
    expect(screen.getByText('Loading media…')).toBeInTheDocument();
    await act(async () => finish({ previews: [], nextOffset: null, unavailable: false }));
    expect(screen.getByText('No published previews yet')).toBeInTheDocument();
  });
  it('shows failure, retries, and renders accessible images and non-autoplay videos', async () => {
    vi.mocked(getRepositoryMedia).mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ previews: [...media, { ...media[0], type: 'video', title: 'Walkthrough', url: 'https://github.com/user-attachments/assets/video' }], nextOffset: null, unavailable: false });
    const { container } = renderPanel();
    expect(await screen.findByRole('alert')).toHaveTextContent('Some media is unavailable');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByAltText('Dashboard preview')).toBeInTheDocument();
    expect(screen.getByLabelText('Walkthrough')).toHaveAttribute('preload', 'none');
    expect(container.querySelector('video')).not.toHaveAttribute('autoplay');
  });
  it('clears media on repository change and disabling, ignoring stale requests', async () => {
    vi.mocked(getRepositoryMedia).mockResolvedValueOnce({ previews: media, nextOffset: null, unavailable: false });
    const { rerender } = renderPanel();
    await screen.findByAltText('Dashboard preview');
    rerender(<RepoActionContainer selectedRepo={{ ...repo, id: 'other', name: 'acme/other' }} initialTab="media" />);
    expect(screen.queryByAltText('Dashboard preview')).not.toBeInTheDocument();
    await waitFor(() => expect(getRepositoryMedia).toHaveBeenLastCalledWith('acme/other', 0));
    rerender(<RepoActionContainer selectedRepo={{ ...repo, visualPreview: { enabled: false } }} settingsContent={<p>Repository settings</p>} />);
    expect(screen.queryByRole('button', { name: 'Media' })).not.toBeInTheDocument();
    expect(screen.getByText('Repository settings')).toBeInTheDocument();
  });
  it('loads additional pages and deduplicates media, preserving partial results on failure', async () => {
    vi.mocked(getRepositoryMedia).mockResolvedValueOnce({ previews: media, nextOffset: 24, unavailable: false })
      .mockResolvedValueOnce({ previews: media, nextOffset: null, unavailable: true });
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Load more media' }));
    await screen.findByRole('alert');
    expect(getRepositoryMedia).toHaveBeenLastCalledWith('acme/web', 24);
    expect(screen.getAllByAltText('Dashboard preview')).toHaveLength(1);
  });
});
