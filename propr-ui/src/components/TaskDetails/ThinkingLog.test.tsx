import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import ThinkingLog from './ThinkingLog';

describe('ThinkingLog without steps', () => {
  it('says so instead of leaving the trace blank', () => {
    render(<ThinkingLog events={[]} emptyMessage="No execution logs recorded — task completed directly." />);
    expect(screen.getByTestId('thinking-log-empty')).toHaveTextContent('No execution logs recorded — task completed directly.');
  });

  it('renders nothing when no empty message is given', () => {
    const { container } = render(<ThinkingLog events={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
