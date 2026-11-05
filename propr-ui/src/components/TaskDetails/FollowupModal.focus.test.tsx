import { useState } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import FollowupModal, { FollowupReceiptError } from './FollowupModal';

const target = { taskId: 'issue-3314-run-0', repository: 'integry/propr', kind: 'issue' as const, number: 3314 };
const prefill = 'Please address the following based on the previous task execution:\n\n';

/** A task page in miniature: a workspace with the Follow Up button, and the dialog beside it. */
function Page({ onSubmit, showInvoker = true }: { onSubmit: (body: string) => Promise<void>; showInvoker?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <main data-testid="workspace">
        {showInvoker && <button type="button" onClick={() => setOpen(true)}>Follow Up</button>}
        <button type="button">Logs</button>
      </main>
      <FollowupModal isOpen={open} onClose={() => setOpen(false)} onSubmit={onSubmit} initialContent={prefill} target={target} />
    </>
  );
}

function openFromKeyboard(onSubmit: (body: string) => Promise<void> = vi.fn().mockResolvedValue(undefined)) {
  const view = render(<Page onSubmit={onSubmit} />);
  const invoker = screen.getByRole('button', { name: 'Follow Up' });
  invoker.focus();
  expect(invoker).toHaveFocus();
  // Enter on a focused button activates it.
  fireEvent.click(invoker);
  return { ...view, invoker, onSubmit };
}

const tab = (shiftKey = false) => fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Tab', shiftKey });
const control = (name: string) => screen.getByRole('button', { name });

describe('FollowupModal keyboard focus', () => {
  test('opens on the Comment, keeps the prefill, and makes the workspace inert', () => {
    openFromKeyboard();
    const comment = screen.getByRole('textbox', { name: 'Comment' });
    expect(comment).toHaveFocus();
    expect(comment).toHaveValue(prefill);
    expect(screen.getByTestId('workspace').inert).toBe(true);
  });

  test('Tab and Shift+Tab cycle through the dialog controls without leaving it', () => {
    openFromKeyboard();
    const comment = screen.getByRole('textbox', { name: 'Comment' });
    const order = [comment, control('Cancel'), control('Post Comment'), control('Close follow-up dialog'), comment];
    for (const next of order.slice(1)) { tab(); expect(next).toHaveFocus(); }
    for (const previous of order.slice(0, -1).reverse()) { tab(true); expect(previous).toHaveFocus(); }
    // Focus pushed outside the dialog comes back to its first or last control.
    (document.activeElement as HTMLElement).blur();
    tab();
    expect(control('Close follow-up dialog')).toHaveFocus();
    (document.activeElement as HTMLElement).blur();
    tab(true);
    expect(control('Post Comment')).toHaveFocus();
  });

  test.each([
    ['Escape', () => fireEvent.keyDown(document.activeElement!, { key: 'Escape' })],
    ['Cancel', () => { tab(); expect(control('Cancel')).toHaveFocus(); fireEvent.click(control('Cancel')); }],
    ['Close', () => { tab(true); expect(control('Close follow-up dialog')).toHaveFocus(); fireEvent.click(control('Close follow-up dialog')); }],
  ])('%s returns focus to the Follow Up button and lifts the inert workspace', (_, dismiss) => {
    const { invoker } = openFromKeyboard();
    act(dismiss);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(invoker).toHaveFocus();
    expect(screen.getByTestId('workspace').inert).toBe(false);
  });

  test('a successful post closes the dialog and returns focus to the Follow Up button', async () => {
    const { invoker, onSubmit } = openFromKeyboard();
    fireEvent.change(screen.getByRole('textbox', { name: 'Comment' }), { target: { value: 'Rerun the focus checks.' } });
    tab(); tab();
    expect(control('Post Comment')).toHaveFocus();
    await act(async () => { fireEvent.click(control('Post Comment')); });
    expect(onSubmit).toHaveBeenCalledWith('Rerun the focus checks.');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(invoker).toHaveFocus();
  });

  test('Tab steps from the focused result through the controls still enabled, then Close restores the invoker', async () => {
    const onSubmit = vi.fn().mockRejectedValue(new FollowupReceiptError({ state: 'failed', posted: true, commentId: 3314, message: 'Comment posted, but the command failed.' }));
    const { invoker } = openFromKeyboard(onSubmit);
    await act(async () => { fireEvent.click(control('Post Comment')); });
    const alert = screen.getByRole('alert');
    expect(alert).toHaveFocus();
    // Post Comment is now blocked against a duplicate, so the cycle skips it.
    expect(control('Post Comment')).toBeDisabled();
    tab();
    expect(control('Close')).toHaveFocus();
    tab();
    expect(control('Close follow-up dialog')).toHaveFocus();
    tab(true);
    expect(control('Close')).toHaveFocus();
    tab(true);
    expect(screen.getByRole('textbox', { name: 'Comment' })).toHaveFocus();
    tab(true);
    expect(control('Close follow-up dialog')).toHaveFocus();
    act(() => { fireEvent.click(control('Close follow-up dialog')); });
    expect(invoker).toHaveFocus();
  });

  test('while posting, Tab stays on the dialog and Escape does not close it', async () => {
    let resolve!: () => void;
    const { invoker } = openFromKeyboard(vi.fn(() => new Promise<void>(done => { resolve = done; })));
    fireEvent.click(control('Post Comment'));
    expect(screen.getByRole('button', { name: /Posting/ })).toBeDisabled();
    tab();
    expect(screen.getByRole('dialog')).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await act(async () => { resolve(); });
    expect(invoker).toHaveFocus();
  });

  test('does not focus a disconnected invoker or take focus back from another control', () => {
    const { invoker, rerender, onSubmit } = openFromKeyboard();
    // The invoker leaves the page while the dialog is open.
    rerender(<Page onSubmit={onSubmit} showInvoker={false} />);
    expect(invoker).not.toBeInTheDocument();
    act(() => { fireEvent.click(control('Cancel')); });
    expect(document.activeElement).toBe(document.body);

    // Opened again; something else takes focus before it closes.
    rerender(<Page onSubmit={onSubmit} />);
    screen.getByRole('button', { name: 'Follow Up' }).focus();
    act(() => { fireEvent.click(screen.getByRole('button', { name: 'Follow Up' })); });
    const elsewhere = document.createElement('button');
    document.body.append(elsewhere);
    elsewhere.focus();
    act(() => { fireEvent.keyDown(elsewhere, { key: 'Escape' }); });
    expect(elsewhere).toHaveFocus();
    expect(screen.getByTestId('workspace').inert).toBe(false);
    elsewhere.remove();
  });
});
