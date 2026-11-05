import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, test } from 'vitest';
import PromptModal from './PromptModal';
import type { PromptData } from './types';

const prompt: PromptData = {
  prompt: 'Please analyze and implement a solution for GitHub issue #28.',
  sessionId: 'session-28-0123456789abcdef0123456789abcdef',
  model: 'claude-opus-5-5',
  timestamp: '2026-10-17T21:15:00.788Z',
  isRetry: false,
  issueRef: { repoOwner: 'integry', repoName: 'propr', number: 28 },
};

function Harness() {
  const [selected, setSelected] = useState<PromptData | null>(null);
  return (
    <>
      <button type="button" onClick={() => setSelected(prompt)}>Prompt</button>
      <button type="button">Behind</button>
      <PromptModal prompt={selected} loading={false} onClose={() => setSelected(null)} />
    </>
  );
}

describe('PromptModal', () => {
  test('is a named modal dialog with a labelled close, Tab containment and focus return', () => {
    render(<Harness />);
    const opener = screen.getByRole('button', { name: 'Prompt' });
    opener.focus();
    fireEvent.click(opener);

    const dialog = screen.getByRole('dialog', { name: 'LLM Prompt' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    const close = within(dialog).getByRole('button', { name: 'Close prompt' });
    expect(close).toHaveFocus();
    // The model keeps its human-readable display name.
    expect(dialog).not.toHaveTextContent('claude-opus-5-5');
    expect(dialog).toHaveTextContent('integry/propr #28');

    // The scrolling prompt details are in the dialog's tab order after Close, and Tab wraps between the two.
    const details = within(dialog).getByRole('region', { name: 'Prompt details' });
    expect(details).toHaveAttribute('tabindex', '0');
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(details).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(close).toHaveFocus();
    // The task workspace behind the dialog is inert.
    expect((screen.getByRole('button', { name: 'Behind', hidden: true }).parentElement as HTMLElement).inert).toBe(true);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(opener).toHaveFocus();

    fireEvent.click(opener);
    fireEvent.click(within(screen.getByRole('dialog', { name: 'LLM Prompt' })).getByRole('button', { name: 'Close prompt' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(opener).toHaveFocus();
  });
});
