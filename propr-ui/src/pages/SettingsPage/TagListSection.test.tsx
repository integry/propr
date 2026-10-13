import { useEffect } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import TagListSection from './TagListSection';
import { useListManagement } from './useListManagement';

const noop = () => {};

/** Follow-up keywords (or, with `required`, primary labels) wired through the real list hook. */
function Harness({ initial = [], onSave = vi.fn(), required = false }: {
  initial?: string[];
  onSave?: (items: string[]) => void;
  required?: boolean;
}) {
  const lists = useListManagement(noop, required ? onSave : noop, required ? noop : onSave, noop);
  const { setKeywords, setPrimaryLabels } = lists;
  useEffect(() => {
    if (required) setPrimaryLabels(initial);
    else setKeywords(initial);
    // Seed once, as loading settings does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return required ? (
    <TagListSection
      title="Primary Processing Labels"
      description="Issues with these labels will be auto-processed."
      items={lists.primaryLabels}
      newItem={lists.newPrimaryLabel}
      placeholder="e.g., AI"
      emptyMessage="No labels configured."
      addLabel="Label name"
      minItems={1}
      onNewItemChange={lists.setNewPrimaryLabel}
      onAddItems={lists.addPrimaryLabels}
      onRemoveItem={lists.removePrimaryLabel}
    />
  ) : (
    <TagListSection
      title="Follow-up Keywords"
      description="Triggers processing when found in comments."
      items={lists.keywords}
      newItem={lists.newKeyword}
      placeholder="e.g., PROPR"
      emptyMessage="No keywords configured."
      addLabel="Keyword"
      onNewItemChange={lists.setNewKeyword}
      onAddItems={lists.addKeywords}
      onRemoveItem={lists.removeKeyword}
    />
  );
}

it('turns typed text into inline chips on Enter or comma, inside the input container', () => {
  const onSave = vi.fn();
  render(<Harness onSave={onSave} />);
  const input = screen.getByLabelText('Keyword');
  expect(screen.getByText('No keywords configured.')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Add' })).toBeNull();

  fireEvent.change(input, { target: { value: 'PROPR' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  fireEvent.change(input, { target: { value: 'FIXIT,' } });

  expect(onSave).toHaveBeenLastCalledWith(['PROPR', 'FIXIT']);
  expect(input).toHaveValue('');
  const container = input.closest('[data-tag-input]');
  expect(container).toContainElement(screen.getByRole('button', { name: 'Remove PROPR' }));
  expect(screen.getByText('FIXIT')).toHaveClass('font-mono');
});

it('commits every entry of a pasted list in one save and keeps only the unfinished one', () => {
  const onSave = vi.fn();
  render(<Harness onSave={onSave} />);
  const input = screen.getByLabelText('Keyword');

  fireEvent.change(input, { target: { value: 'FIX,REVIEW,DONE' } });
  expect(onSave).toHaveBeenCalledTimes(1);
  expect(onSave).toHaveBeenLastCalledWith(['FIX', 'REVIEW']);
  expect(input).toHaveValue('DONE');

  fireEvent.keyDown(input, { key: 'Enter' });
  expect(onSave).toHaveBeenLastCalledWith(['FIX', 'REVIEW', 'DONE']);
  expect(input).toHaveValue('');
});

it('never commits a comma-containing remainder on Enter', () => {
  const onSave = vi.fn();
  render(<Harness onSave={onSave} />);
  const input = screen.getByLabelText('Keyword');

  fireEvent.change(input, { target: { value: 'alice, bob ,carol,' } });
  expect(onSave).toHaveBeenLastCalledWith(['alice', 'bob', 'carol']);
  expect(input).toHaveValue('');
  for (const entry of ['alice', 'bob', 'carol']) {
    expect(screen.getByRole('button', { name: `Remove ${entry}` })).toBeInTheDocument();
  }
});

it('keeps a duplicate typed before a comma visible with the warning', () => {
  const onSave = vi.fn();
  render(<Harness initial={['AI']} onSave={onSave} />);
  const input = screen.getByLabelText('Keyword');

  fireEvent.change(input, { target: { value: 'AI,' } });
  expect(onSave).not.toHaveBeenCalled();
  expect(input).toHaveValue('AI, ');
  expect(screen.getByText('“AI” is already in the list.')).toBeInTheDocument();

  // Deleting back over the comma is not undone by re-parsing.
  fireEvent.change(input, { target: { value: 'AI,' } });
  fireEvent.change(input, { target: { value: 'AI' } });
  expect(input).toHaveValue('AI');

  fireEvent.keyDown(input, { key: 'Enter' });
  expect(onSave).not.toHaveBeenCalled();
  expect(input).toHaveValue('AI');
  expect(screen.getByText('“AI” is already in the list.')).toBeInTheDocument();
});

it('leaves typed text in the field on blur instead of saving it', () => {
  const onSave = vi.fn();
  render(<Harness initial={['AI']} onSave={onSave} />);
  const input = screen.getByLabelText('Keyword');

  fireEvent.change(input, { target: { value: 'doc' } });
  fireEvent.blur(input);
  expect(onSave).not.toHaveBeenCalled();
  expect(input).toHaveValue('doc');
});

it('needs a second Backspace to remove the last chip', () => {
  const onSave = vi.fn();
  render(<Harness initial={['AI', 'bug']} onSave={onSave} />);
  const input = screen.getByLabelText('Keyword');

  fireEvent.keyDown(input, { key: 'Backspace' });
  expect(onSave).not.toHaveBeenCalled();
  expect(screen.getByText('bug').closest('[data-removal-armed]')).not.toBeNull();
  expect(screen.getByText('Press Backspace again to remove “bug”.')).toBeInTheDocument();

  // Any other key disarms the removal.
  fireEvent.keyDown(input, { key: 'ArrowLeft' });
  fireEvent.keyDown(input, { key: 'Backspace' });
  expect(onSave).not.toHaveBeenCalled();

  fireEvent.keyDown(input, { key: 'Backspace' });
  expect(onSave).toHaveBeenLastCalledWith(['AI']);
  expect(screen.queryByText('bug')).toBeNull();
});

it('ignores a held Backspace once it has cleared the draft', () => {
  const onSave = vi.fn();
  render(<Harness initial={['AI', 'bug']} onSave={onSave} />);
  const input = screen.getByLabelText('Keyword');
  fireEvent.change(input, { target: { value: 'do' } });

  // Holding Backspace: the first event and its auto-repeats clear the draft…
  fireEvent.keyDown(input, { key: 'Backspace' });
  fireEvent.change(input, { target: { value: 'd' } });
  fireEvent.keyDown(input, { key: 'Backspace', repeat: true });
  fireEvent.change(input, { target: { value: '' } });
  // …and the repeats that keep arriving on the empty field touch no chip.
  for (let i = 0; i < 6; i++) fireEvent.keyDown(input, { key: 'Backspace', repeat: true });
  expect(onSave).not.toHaveBeenCalled();
  expect(screen.getByText('bug').closest('[data-removal-armed]')).toBeNull();
  expect(screen.getByText('AI')).toBeInTheDocument();

  // Holding a fresh press arms the removal, but only another press removes.
  fireEvent.keyDown(input, { key: 'Backspace' });
  fireEvent.keyDown(input, { key: 'Backspace', repeat: true });
  expect(onSave).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: 'Backspace' });
  for (let i = 0; i < 6; i++) fireEvent.keyDown(input, { key: 'Backspace', repeat: true });
  expect(onSave).toHaveBeenCalledTimes(1);
  expect(onSave).toHaveBeenLastCalledWith(['AI']);
});

it('never removes the last required label', () => {
  const onSave = vi.fn();
  render(<Harness required initial={['AI']} onSave={onSave} />);
  const input = screen.getByLabelText('Label name');

  fireEvent.keyDown(input, { key: 'Backspace' });
  fireEvent.keyDown(input, { key: 'Backspace' });
  const remove = screen.getByRole('button', { name: 'Remove AI' });
  expect(remove).toBeDisabled();
  fireEvent.click(remove);

  expect(onSave).not.toHaveBeenCalled();
  expect(screen.getByText('AI')).toBeInTheDocument();
});
