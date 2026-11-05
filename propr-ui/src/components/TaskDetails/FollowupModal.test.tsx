import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import FollowupModal, { FollowupReceiptError } from './FollowupModal';
import type { FollowupTarget } from './types';

const longText = `Please address the following:\n\n${'- another detail\n'.repeat(80)}`;

const issueTarget = { taskId: 'issue-3127-run', repository: 'integry/propr', kind: 'issue' as const, number: 3127 };

function renderModal(onSubmit: (body: string) => Promise<void>, onClose = vi.fn(), target: FollowupTarget | null = issueTarget) {
  render(<FollowupModal isOpen onClose={onClose} onSubmit={onSubmit} initialContent="" target={target} />);
  const textarea = screen.getByRole('textbox', { name: 'Comment' });
  fireEvent.change(textarea, { target: { value: longText } });
  return { textarea, post: screen.getByRole('button', { name: 'Post Comment' }), onClose };
}

describe('FollowupModal submission feedback', () => {
  test('a posted-but-not-submitted receipt is announced, focused, keeps the text and blocks an identical repost', async () => {
    const onSubmit = vi.fn().mockRejectedValue(new FollowupReceiptError({
      state: 'failed', posted: true, commentId: 9001, message: 'Comment posted, but the command failed before submission.',
    }));
    const { textarea, post, onClose } = renderModal(onSubmit);

    await act(async () => { fireEvent.click(post); });

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Comment posted, but the command was not submitted');
    expect(alert).toHaveTextContent('Comment posted, but the command failed before submission.');
    expect(alert).toHaveTextContent('Comment9001');
    expect(alert).toHaveTextContent('Statefailed');
    expect(alert).toHaveFocus();
    expect(textarea).toHaveValue(longText);
    expect(onClose).not.toHaveBeenCalled();

    const blocked = screen.getByRole('button', { name: 'Post Comment' });
    expect(blocked).toBeDisabled();
    expect(blocked).toHaveAccessibleDescription(/duplicate comment/);
    fireEvent.click(blocked);
    expect(onSubmit).toHaveBeenCalledTimes(1);

    // An intentional edit is a new comment, so it may be posted.
    fireEvent.change(textarea, { target: { value: `${longText}\nOnly the second half, please.` } });
    expect(screen.getByRole('button', { name: 'Post Comment' })).toBeEnabled();
    expect(alert).toHaveTextContent('Post Comment will add it as a new comment');
  });

  test('an unknown outcome or a missing receipt also refuses a blind repost', async () => {
    const onSubmit = vi.fn()
      .mockRejectedValueOnce(new FollowupReceiptError({ state: 'unknown', posted: true, commentId: 7, jobId: 'job-7', message: 'Inspect first.' }))
      .mockRejectedValueOnce(new Error('Network down.'));
    const { textarea, post } = renderModal(onSubmit);

    await act(async () => { fireEvent.click(post); });
    expect(await screen.findByRole('alert')).toHaveTextContent('Comment posted, but submission is unconfirmed');
    expect(screen.getByRole('alert')).toHaveTextContent('job-7');
    expect(screen.getByRole('button', { name: 'Post Comment' })).toBeDisabled();

    fireEvent.change(textarea, { target: { value: 'A different request' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Post Comment' })); });
    expect(await screen.findByRole('alert')).toHaveTextContent('Follow-up outcome unknown');
    expect(screen.getByRole('alert')).toHaveTextContent('Network down. The comment may still have been posted.');
    expect(screen.getByRole('button', { name: 'Post Comment' })).toBeDisabled();
  });

  test('a receipt that says nothing was posted allows a retry of the same text', async () => {
    const onSubmit = vi.fn()
      .mockRejectedValueOnce(new FollowupReceiptError({ state: 'failed', posted: false, message: 'GitHub rejected the comment.' }))
      .mockResolvedValueOnce(undefined);
    const { post, onClose } = renderModal(onSubmit);

    await act(async () => { fireEvent.click(post); });
    expect(await screen.findByRole('alert')).toHaveTextContent('Follow-up was not posted');
    const retry = screen.getByRole('button', { name: 'Post Comment' });
    expect(retry).toBeEnabled();
    await act(async () => { fireEvent.click(retry); });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });

  test('a double click while posting submits once', async () => {
    let resolve!: () => void;
    const onSubmit = vi.fn(() => new Promise<void>(done => { resolve = done; }));
    const { post } = renderModal(onSubmit);
    fireEvent.click(post);
    fireEvent.click(post);
    await act(async () => { resolve(); });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  test('names the resolved thread with its full repository, or none and refuses to post', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const { unmount } = render(<FollowupModal isOpen onClose={vi.fn()} onSubmit={onSubmit} initialContent="Go"
      target={{ taskId: 'issue-27-run', repository: 'owner/repository', kind: 'pull_request', number: 28 }} />);
    expect(screen.getByRole('dialog')).toHaveAccessibleDescription('Post a comment to PR owner/repository#28');
    unmount();

    renderModal(onSubmit, vi.fn(), null);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAccessibleDescription('The GitHub thread for this follow-up is not available. Refresh the task before posting.');
    expect(dialog).not.toHaveTextContent('#');
    const post = screen.getByRole('button', { name: 'Post Comment' });
    expect(post).toBeDisabled();
    fireEvent.click(post);
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
