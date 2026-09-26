import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseISO8601Timestamp, type Notification } from '@propr/shared';
import { PreviewThumbnails } from './PreviewMedia';
import { downsampleToCanvas } from './previewDownsampling';
import { ParentTaskRow, ChildTaskRow } from './TaskList/TaskRows';
import { MobileTaskCard } from './TaskList/MobileTaskCard';
import { InboxCard } from '../pages/InboxPageComponents';
import { AuthProvider } from '../contexts/AuthContext';
import type { CurrentUser } from '../api/proprTypes';

vi.mock('./Inbox/NotificationActions', () => ({ default: () => null }));
afterEach(() => vi.restoreAllMocks());
const media = Array.from({ length: 5 }, (_, i) => ({ title: `Published screen ${i}`, type: 'image' as const, url: `https://github.com/user-attachments/assets/screen-${i}` }));
const task = { id: 'task-1', status: 'completed', title: 'Ship media', createdAt: '2026-09-13', previewMedia: media };
const group = { key: 'one', repoOwner: 'acme', repoName: 'web', tasks: [task] };

describe('preview thumbnails', () => {
  it('limits trusted images, provides alt text and handles unavailable images', () => {
    render(<PreviewThumbnails media={[{ ...media[0], url: 'https://evil.test/image.png' }, ...media]} />);
    expect(screen.getAllByRole('img')).toHaveLength(3);
    expect(screen.getByAltText('Published screen 0')).toHaveAttribute('loading', 'lazy');
    fireEvent.error(screen.getByAltText('Published screen 0'));
    expect(screen.getByRole('img', { name: /screen 0 — image unavailable/ })).toBeInTheDocument();
  });
  it('drops a rail thumbnail whose image fails instead of showing a placeholder', () => {
    render(<PreviewThumbnails media={media} limit={1} size="rail" />);
    const group = screen.getByRole('group', { name: 'Published visual previews' });
    fireEvent.error(screen.getByAltText('Published screen 0'));
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(group).toBeEmptyDOMElement();
  });
  it('renders nothing for legacy or disabled projections', () => {
    const { container } = render(<PreviewThumbnails />);
    expect(container).toBeEmptyDOMElement();
  });
  it('uses explicit video treatment without video playback in compact rows', () => {
    const { container } = render(<PreviewThumbnails media={[{ ...media[0], type: 'video' }]} />);
    expect(screen.getByRole('img', { name: /Video preview: Published screen 0/ })).toBeInTheDocument();
    expect(container.querySelector('video')).toBeNull();
  });
  it('loads application media with authenticated fetch and drops the old blob on account switch', async () => {
    const protectedMedia = [{ ...media[0], url: '/api/preview-media/pulls/acme/web/49/private-asset' }];
    const user = (id: string) => ({ id, username: id, permissions: [] }) as unknown as CurrentUser;
    const responses: Array<(response: Response) => void> = [];
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(resolve => responses.push(resolve)));
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValueOnce('blob:account-a').mockReturnValueOnce('blob:account-b');
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const { rerender } = render(<AuthProvider user={user('account-a')}><PreviewThumbnails media={protectedMedia} /></AuthProvider>);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await act(async () => { responses[0]?.(new Response('image-a', { status: 200, headers: { 'Content-Type': 'image/png' } })); });
    expect(await screen.findByAltText('Published screen 0')).toHaveAttribute('src', 'blob:account-a');

    rerender(<AuthProvider user={user('account-b')}><PreviewThumbnails media={protectedMedia} /></AuthProvider>);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(screen.queryByAltText('Published screen 0')).not.toBeInTheDocument();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:account-a');
    await act(async () => { responses[1]?.(new Response('image-b', { status: 200, headers: { 'Content-Type': 'image/png' } })); });
    expect(await screen.findByAltText('Published screen 0')).toHaveAttribute('src', 'blob:account-b');
    expect(createObjectURL).toHaveBeenCalledTimes(2);
    rerender(<AuthProvider user={null}><PreviewThumbnails media={protectedMedia} /></AuthProvider>);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(screen.queryByAltText('Published screen 0')).not.toBeInTheDocument();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:account-b');
  });
  it.each([false, true])('renders 3 previews in parent and child rows (desktop=%s)', desktopLayout => {
    render(<table><tbody><ParentTaskRow group={group} task={task} desktopLayout={desktopLayout} onRowClick={vi.fn()} /><ChildTaskRow task={task} desktopLayout={desktopLayout} onRowClick={vi.fn()} /></tbody></table>);
    for (const row of screen.getAllByRole('row')) expect(within(row).getAllByRole('img', { name: /Published screen/ })).toHaveLength(3);
  });
  it('renders 3 previews in the mobile task layout', () => {
    render(<MobileTaskCard group={group} expandedGroups={new Set()} onRowClick={vi.fn()} onToggleGroup={vi.fn()} />);
    expect(screen.getAllByRole('img', { name: /Published screen/ })).toHaveLength(3);
  });
  it.each([['task', 'success', 1], ['task', 'error', 0], ['task', 'warning', 0], ['review', 'success', 0], ['plan', 'success', 0]])('Inbox %s/%s shows %s previews', (kind, severity, count) => {
    const notification = { id: 'n-1', kind, severity, target: { type: kind, repository: 'acme/web', taskId: 'task-1' }, readAt: null,
      title: 'Task completed', body: 'Ready to review', occurredAt: '2026-09-13', previewMedia: media } as Notification;
    render(<MemoryRouter><InboxCard notification={notification} onDismiss={vi.fn()} onOpen={vi.fn()} mutationsEnabled={false} /></MemoryRouter>);
    expect(screen.queryAllByRole('img', { name: /Published screen/ })).toHaveLength(count);
  });
  it.each([
    { completion: true, enabled: true, count: 1 },
    { completion: true, enabled: false, count: 0 },
    { completion: false, enabled: true, count: 0 },
  ])('PR Inbox completion=$completion enabled=$enabled shows $count previews', ({ completion, enabled, count }) => {
    const onOpen = vi.fn();
    const notification: Notification = {
      id: 'pr-completion', deduplicationKey: 'pr-completion', kind: 'pull_request', severity: 'info',
      target: { type: 'pull_request', repository: 'acme/web', prNumber: 42 },
      title: 'Implement repository media', body: 'PR #42 is ready for review.',
      actions: ['open_pr', 'dismiss'],
      action: { type: 'external_link', label: 'Open PR', href: 'https://github.com/acme/web/pull/42' },
      occurredAt: parseISO8601Timestamp('2026-09-13T12:00:00.000Z'), createdAt: parseISO8601Timestamp('2026-09-13T12:00:00.000Z'),
      readAt: null, dismissedAt: null,
      ...(completion ? { metadata: { completedImplementationTaskId: 'implementation-1' } } : {}),
      ...(enabled ? { previewMedia: media } : {}),
    };
    render(<MemoryRouter><InboxCard notification={notification} onDismiss={vi.fn()} onOpen={onOpen} mutationsEnabled={false} /></MemoryRouter>);
    expect(screen.queryAllByRole('img', { name: /Published screen/ })).toHaveLength(count);
    const details = screen.getByRole('link', { name: /Implement repository media/ });
    expect(details).toHaveAttribute('href', 'https://github.com/acme/web/pull/42');
    fireEvent.click(details);
    expect(onOpen).toHaveBeenCalledWith(notification.id);
  });
});

describe('compact preview downsampling', () => {
  function mockCanvasContexts() {
    const draws: Array<{ target: HTMLCanvasElement; width: number; height: number; quality: string }> = [];
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
      const context = {
        canvas: this, imageSmoothingEnabled: false, imageSmoothingQuality: 'low', clearRect: vi.fn(),
        drawImage: (...args: number[]) => draws.push({ target: context.canvas, width: args[7], height: args[8], quality: context.imageSmoothingQuality }),
      };
      return context as unknown as CanvasRenderingContext2D;
    } as never);
    return { draws, restore: () => getContext.mockRestore() };
  }
  function sourceImage(width: number, height: number) {
    const image = document.createElement('img');
    Object.defineProperty(image, 'naturalWidth', { value: width });
    Object.defineProperty(image, 'naturalHeight', { value: height });
    return image;
  }

  it('halves 4K captures in steps and draws a contain-fit, device-pixel-ratio backing store with high smoothing', () => {
    const { draws, restore } = mockCanvasContexts();
    const originalRatio = window.devicePixelRatio;
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2 });
    try {
      const canvas = document.createElement('canvas');
      expect(downsampleToCanvas(sourceImage(3840, 2160), canvas, 80, 56)).toBe(true);
      // Contain fit: a 16:9 capture in an 80x56 box is 80x45 CSS pixels, 160x90 device pixels.
      expect(canvas.style.width).toBe('80px');
      expect(canvas.style.height).toBe('45px');
      expect([canvas.width, canvas.height]).toEqual([160, 90]);
      expect(draws.map(draw => [draw.width, draw.height])).toEqual([[1920, 1080], [960, 540], [480, 270], [240, 135], [160, 90]]);
      expect(draws.every(draw => draw.quality === 'high')).toBe(true);
      expect(draws.at(-1)?.target).toBe(canvas);
    } finally {
      Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: originalRatio });
      restore();
    }
  });

  it('keeps the lazy accessible image with aspect-preserving layout and a presentation-only canvas', () => {
    render(<PreviewThumbnails media={[media[0]]} />);
    const image = screen.getByAltText('Published screen 0');
    expect(image).toHaveAttribute('loading', 'lazy');
    expect(image).toHaveClass('object-contain');
    expect(image).not.toHaveClass('object-cover');
    expect(screen.getByTestId('preview-thumbnail-canvas')).toHaveAttribute('aria-hidden', 'true');
  });

  it('falls back to the native image when no canvas context is available', () => {
    const canvas = document.createElement('canvas');
    vi.spyOn(canvas, 'getContext').mockReturnValue(null);
    expect(downsampleToCanvas(sourceImage(1920, 1080), canvas, 80, 56)).toBe(false);
  });
});
