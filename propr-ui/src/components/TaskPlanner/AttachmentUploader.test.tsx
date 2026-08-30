import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setDesktopConnectionScope } from '../../api/apiClient';
import { AttachmentUploader } from './AttachmentUploader';

describe('AttachmentUploader previews', () => {
  afterEach(() => {
    cleanup();
    setDesktopConnectionScope(null);
    vi.restoreAllMocks();
  });

  it('clears and reloads a text preview when the desktop scope changes', async () => {
    let fetchCalls = 0;
    let resolveSecondFetch!: (response: Response) => void;
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      fetchCalls += 1;
      if (fetchCalls === 1) return Promise.resolve(new Response('profile A preview', { status: 200 }));
      return new Promise(resolve => { resolveSecondFetch = resolve; });
    });
    setDesktopConnectionScope({
      bridge: {} as never,
      profileId: 'profile-a',
      transportScope: 'AAAAAAAAAAAAAAAAAAAAAA',
    });
    render(<AttachmentUploader
      files={[{ id: 'attachment-a', originalName: 'notes.txt', tokenEstimate: 3, type: 'text' }]}
      draftId="draft-a"
      isUploading={false}
      onUpload={async () => undefined}
      onRemove={async () => undefined}
    />);

    const filename = screen.getByText('notes.txt');
    await waitFor(() => expect(filename).toHaveAttribute('title', 'profile A preview'));

    await act(async () => {
      setDesktopConnectionScope({
        bridge: {} as never,
        profileId: 'profile-b',
        transportScope: 'BBBBBBBBBBBBBBBBBBBBBB',
      });
    });

    await waitFor(() => expect(fetchCalls).toBe(2));
    expect(filename).toHaveAttribute('title', 'Loading preview…');
    await act(async () => { resolveSecondFetch(new Response('profile B preview', { status: 200 })); });
    await waitFor(() => expect(filename).toHaveAttribute('title', 'profile B preview'));
  });
});
