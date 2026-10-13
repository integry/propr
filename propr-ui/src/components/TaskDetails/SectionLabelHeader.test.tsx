import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
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

  it('shows the readable log header without a view selector', () => {
    render(<SectionLabelHeader commandMode="fix" stepCount={2} />);
    expect(screen.getByRole('heading', { name: 'EXECUTION TRACE' })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Log view' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Human readable' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Raw' })).not.toBeInTheDocument();
  });
});
