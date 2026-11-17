import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import MarkdownRenderer from './MarkdownRenderer';

const TEXT = '# Summary\n\nThe first paragraph a reader selects.\n\n- one\n- two';

describe('MarkdownRenderer', () => {
  afterEach(cleanup);

  it('keeps every element when a parent re-renders it with the same text', () => {
    const { rerender } = render(<MarkdownRenderer text={TEXT} />);
    const heading = screen.getByRole('heading', { name: 'Summary' });
    const paragraph = screen.getByText('The first paragraph a reader selects.');
    const item = screen.getByText('one');

    // A new string with the same content, as a refreshed response carries.
    rerender(<MarkdownRenderer text={`${TEXT}`.slice(0)} />);
    rerender(<MarkdownRenderer text={TEXT.split('').join('')} />);

    expect(screen.getByRole('heading', { name: 'Summary' })).toBe(heading);
    expect(screen.getByText('The first paragraph a reader selects.')).toBe(paragraph);
    expect(screen.getByText('one')).toBe(item);
  });

  it('updates changed text in place, leaving earlier elements untouched when text is appended', () => {
    const { rerender } = render(<MarkdownRenderer text={TEXT} />);
    const paragraph = screen.getByText('The first paragraph a reader selects.');

    rerender(<MarkdownRenderer text={`${TEXT}\n\nA streamed addition.`} />);
    expect(screen.getByText('A streamed addition.')).toBeInTheDocument();
    expect(screen.getByText('The first paragraph a reader selects.')).toBe(paragraph);

    rerender(<MarkdownRenderer text={'# Summary\n\nA rewritten paragraph.'} />);
    expect(screen.getByText('A rewritten paragraph.')).toBeInTheDocument();
    expect(screen.queryByText('The first paragraph a reader selects.')).not.toBeInTheDocument();
  });

  it('still labels a code block with the file named above it', () => {
    render(<MarkdownRenderer text={'Intro\n\n```text\nplain\n```\n\nFile: `src/app/main.ts`\n```ts\nconst a = 1;\n```'} />);
    expect(screen.getByText('main.ts')).toBeInTheDocument();
    expect(screen.getByText('src/app/')).toBeInTheDocument();
  });
});
