import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setDesktopConnectionScope } from '../../api/apiClient';
import { AuthenticatedAttachmentImage } from './AuthenticatedAttachmentImage';

describe('AuthenticatedAttachmentImage', () => {
  afterEach(() => {
    cleanup();
    setDesktopConnectionScope(null);
    vi.restoreAllMocks();
  });

  it('clears the previous image and fetches it again under the new scope', async () => {
    let fetchCalls = 0;
    let resolveSecondFetch!: (response: Response) => void;
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      fetchCalls += 1;
      if (fetchCalls === 1) return Promise.resolve(new Response('image-a', { status: 200 }));
      return new Promise(resolve => { resolveSecondFetch = resolve; });
    });
    const createObjectURL = vi.spyOn(URL, 'createObjectURL')
      .mockReturnValueOnce('blob:attachment-a')
      .mockReturnValueOnce('blob:attachment-b');
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    setDesktopConnectionScope({
      bridge: {} as never,
      profileId: 'profile-a',
      transportScope: 'AAAAAAAAAAAAAAAAAAAAAA',
    });
    const { unmount } = render(<AuthenticatedAttachmentImage src="/api/attachments/a" alt="attachment" />);

    expect(await screen.findByRole('img', { name: 'attachment' })).toHaveAttribute('src', 'blob:attachment-a');
    expect(createObjectURL).toHaveBeenCalledOnce();
    await act(async () => {
      setDesktopConnectionScope({
        bridge: {} as never,
        profileId: 'profile-b',
        transportScope: 'BBBBBBBBBBBBBBBBBBBBBB',
      });
    });

    await waitFor(() => expect(fetchCalls).toBe(2));
    expect(screen.queryByRole('img', { name: 'attachment' })).not.toBeInTheDocument();
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:attachment-a');
    await act(async () => { resolveSecondFetch(new Response('image-b', { status: 200 })); });
    expect(await screen.findByRole('img', { name: 'attachment' })).toHaveAttribute('src', 'blob:attachment-b');
    unmount();
    expect(revokeObjectURL).toHaveBeenNthCalledWith(2, 'blob:attachment-b');
    expect(revokeObjectURL).toHaveBeenCalledTimes(2);
    expect(createObjectURL).toHaveBeenCalledTimes(2);
  });

  it('aborts the old request on scope change and the replacement request on unmount', async () => {
    const requestSignals: AbortSignal[] = [];
    const resolveFetches: Array<(response: Response) => void> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
      if (init?.signal) requestSignals.push(init.signal);
      return new Promise(resolve => { resolveFetches.push(resolve); });
    });
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:late');
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    setDesktopConnectionScope({
      bridge: {} as never,
      profileId: 'profile-a',
      transportScope: 'AAAAAAAAAAAAAAAAAAAAAA',
    });
    const { unmount } = render(<AuthenticatedAttachmentImage src="/api/attachments/a" alt="attachment" />);
    await waitFor(() => expect(requestSignals).toHaveLength(1));
    const requestSignal = requestSignals[0];
    if (!requestSignal) throw new Error('Expected attachment fetch to capture an AbortSignal');

    await act(async () => {
      setDesktopConnectionScope({
        bridge: {} as never,
        profileId: 'profile-b',
        transportScope: 'BBBBBBBBBBBBBBBBBBBBBB',
      });
    });
    await waitFor(() => expect(requestSignals).toHaveLength(2));
    expect(requestSignal.aborted).toBe(true);
    expect(requestSignals[1]?.aborted).toBe(false);
    resolveFetches[0]?.(new Response('late', { status: 200 }));
    await Promise.resolve();
    expect(screen.queryByRole('img', { name: 'attachment' })).not.toBeInTheDocument();
    unmount();
    expect(requestSignals[1]?.aborted).toBe(true);
    expect(revokeObjectURL).not.toHaveBeenCalled();
  });
});
