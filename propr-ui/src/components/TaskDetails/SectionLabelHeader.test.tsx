import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import SectionLabelHeader from './SectionLabelHeader';

describe('SectionLabelHeader', () => {
  it('names a review log by what it holds, never an implementation log', () => {
    render(<SectionLabelHeader commandMode="review" stepCount={2} />);
    expect(screen.getByRole('heading', { name: 'REVIEW FINDINGS' })).toBeInTheDocument();
    expect(screen.queryByText(/IMPLEMENTATION/)).toBeNull();
    expect(screen.getByTestId('log-step-count')).toHaveTextContent('2 steps');
  });

  it.each([undefined, 'fix', 'implement'])('calls a %s run an execution trace', commandMode => {
    render(<SectionLabelHeader commandMode={commandMode} stepCount={1} />);
    expect(screen.getByRole('heading', { name: 'EXECUTION TRACE' })).toBeInTheDocument();
    expect(screen.getByTestId('log-step-count')).toHaveTextContent('1 step');
  });

  it('switches between the readable log and the raw terminal', () => {
    const onViewChange = vi.fn();
    render(<SectionLabelHeader commandMode="fix" view="readable" onViewChange={onViewChange} />);
    expect(screen.getByRole('button', { name: 'Human readable' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Raw' }));
    expect(onViewChange).toHaveBeenCalledWith('terminal');
    expect(screen.getByRole('group', { name: 'Log view' })).toHaveAttribute('data-execution-log-control');
  });
});
