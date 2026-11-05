import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import RepoActionContainer from './RepoActionContainer';
import { getRepositoryMedia } from '../../api/repositoryMediaApi';
vi.mock('../../api/repositoryMediaApi', () => ({ getRepositoryMedia: vi.fn() }));
vi.mock('../../api/proprApi', () => ({ getInstanceCatalog: async () => ({ agents: [] }) }));
vi.mock('../../api/repoChatApi', () => ({ getChatMessages: async () => [] }));
vi.mock('../../contexts/DemoModeContext', () => ({ useDemoMode: () => ({ isDemoMode: false }) }));
const repo = { id: 'repo-1', name: 'acme/web', visualPreview: { enabled: true } };
const media = [{ title: 'Dashboard preview', type: 'image' as const, url: 'https://github.com/user-attachments/assets/dashboard' }];
const video = { title: 'Walkthrough', type: 'video' as const, url: 'https://github.com/user-attachments/assets/video' };
const renderPanel = (enabled = true) => render(<RepoActionContainer selectedRepo={{ ...repo, visualPreview: { enabled } }} initialTab="media" settingsContent={<p>Repository settings</p>} />);

beforeEach(() => { vi.clearAllMocks(); vi.mocked(getRepositoryMedia).mockResolvedValue({ previews: [], nextOffset: null, unavailable: false }); });
describe('repository Media tab', () => {
  it.each([false, undefined])('omits tab and requests for disabled/legacy repositories (%s)', enabled => {
    render(<RepoActionContainer selectedRepo={{ ...repo, visualPreview: enabled === undefined ? undefined : { enabled } }} initialTab="media" settingsContent={<p>Repository settings</p>} />);
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
    vi.mocked(getRepositoryMedia).mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ previews: [...media, video], nextOffset: null, unavailable: false });
    const { container } = renderPanel();
    expect(await screen.findByRole('alert')).toHaveTextContent('Some media is unavailable');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByAltText('Dashboard preview')).toBeInTheDocument();
    // The tile is a lightbox trigger, so its poster frame stays silent and out of the tab order.
    const poster = container.querySelector('video') as HTMLVideoElement;
    expect(screen.getByRole('button', { name: 'Open preview: Walkthrough' })).toContainElement(poster);
    expect(poster).not.toHaveAttribute('autoplay');
    expect(poster).not.toHaveAttribute('controls');
    expect(poster).toHaveAttribute('tabindex', '-1');
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

describe('repository Media lightbox', () => {
  const gallery = [...media, video, { ...media[0], title: 'Billing preview', url: 'https://github.com/user-attachments/assets/billing' }];
  const openGallery = async (name = 'Open preview: Dashboard preview') => {
    vi.mocked(getRepositoryMedia).mockResolvedValue({ previews: gallery, nextOffset: null, unavailable: false });
    renderPanel();
    const tile = await screen.findByRole('button', { name });
    fireEvent.click(tile);
    return tile;
  };

  it('opens media in an in-app modal dialog instead of a new tab', async () => {
    await openGallery();
    expect(screen.queryByRole('link', { name: /Open preview/ })).not.toBeInTheDocument();
    const dialog = screen.getByRole('dialog', { name: 'Dashboard preview' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog.parentElement).toBe(document.body);
    expect(document.body.style.overflow).toBe('hidden');
    expect(screen.getByRole('button', { name: 'Close preview' })).toHaveFocus();
  });

  it('plays a video inline in the dialog with its native controls', async () => {
    await openGallery('Open preview: Walkthrough');
    const player = screen.getByRole('dialog', { name: 'Walkthrough' }).querySelector('video') as HTMLVideoElement;
    expect(player).toHaveAttribute('controls');
    expect(player).toHaveAttribute('src', video.url);
    expect(player).not.toHaveAttribute('autoplay');
    // Zoom belongs to images; a video keeps its own transport controls uncluttered.
    expect(screen.queryByRole('button', { name: 'Zoom in' })).toBeNull();
  });

  it.each([
    ['the close button', () => fireEvent.click(screen.getByRole('button', { name: 'Close preview' }))],
    ['the backdrop', () => fireEvent.click(screen.getByTestId('preview-lightbox-stage'))],
    ['Escape', () => fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })],
  ])('closes on %s and restores focus to the tile that opened it', async (_label, close) => {
    const tile = await openGallery();
    close();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(tile).toHaveFocus();
    expect(document.body.style.overflow).toBe('');
  });

  it('navigates the whole collection with controls and arrow keys, wrapping at both ends', async () => {
    await openGallery();
    expect(screen.getByText('1 / 3')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Next preview' }));
    expect(screen.getByRole('dialog', { name: 'Walkthrough' })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowRight' });
    expect(screen.getByRole('dialog', { name: 'Billing preview' })).toBeInTheDocument();
    expect(screen.getByText('3 / 3')).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowRight' });
    expect(screen.getByRole('dialog', { name: 'Dashboard preview' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Previous preview' }));
    expect(screen.getByRole('dialog', { name: 'Billing preview' })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowLeft' });
    expect(screen.getByRole('dialog', { name: 'Walkthrough' })).toBeInTheDocument();
  });
});
