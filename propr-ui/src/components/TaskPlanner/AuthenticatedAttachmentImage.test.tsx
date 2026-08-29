import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setDesktopConnectionScope } from '../../api/apiClient';
import { AuthenticatedAttachmentImage } from './AuthenticatedAttachmentImage';

describe('AuthenticatedAttachmentImage', () => {
  afterEach(() => {
    cleanup();
    setDesktopConnectionScope(null);
    vi.restoreAllMocks();
  });

  it('revokes its object URL and clears the image when the captured scope rotates', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('image', { status: 200 }));
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:attachment-a');
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    setDesktopConnectionScope({
      bridge: {} as never,
      profileId: 'profile-a',
      transportScope: 'AAAAAAAAAAAAAAAAAAAAAA',
    });
    const { unmount } = render(<AuthenticatedAttachmentImage src="/api/attachments/a" alt="attachment" />);

    expect(await screen.findByRole('img', { name: 'attachment' })).toHaveAttribute('src', 'blob:attachment-a');
    expect(createObjectURL).toHaveBeenCalledOnce();
    setDesktopConnectionScope({
      bridge: {} as never,
      profileId: 'profile-b',
      transportScope: 'BBBBBBBBBBBBBBBBBBBBBB',
    });

    await waitFor(() => expect(screen.queryByRole('img', { name: 'attachment' })).not.toBeInTheDocument());
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:attachment-a');
    unmount();
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
  });

  it('aborts a pending attachment request on scope change and revokes on unmount', async () => {
    const requestSignals: AbortSignal[] = [];
    let resolveFetch!: (response: Response) => void;
    vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
      if (init?.signal) requestSignals.push(init.signal);
      return new Promise(resolve => { resolveFetch = resolve; });
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

    setDesktopConnectionScope({
      bridge: {} as never,
      profileId: 'profile-b',
      transportScope: 'BBBBBBBBBBBBBBBBBBBBBB',
    });
    expect(requestSignal.aborted).toBe(true);
    resolveFetch(new Response('late', { status: 200 }));
    await Promise.resolve();
    expect(screen.queryByRole('img', { name: 'attachment' })).not.toBeInTheDocument();
    unmount();
    expect(revokeObjectURL).not.toHaveBeenCalled();
  });
});
