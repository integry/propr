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

describe('ThinkingLog summary', () => {
  const events = [
    { type: 'thought' as const, content: 'Applying the oauthFlow edits:', timestamp: '2026-10-05T10:00:00Z' },
    { type: 'thought' as const, content: 'Worker side is done. Now the app: viewing the remaining proxy call sites.', timestamp: '2026-10-05T10:01:00Z' },
    { type: 'thought' as const, content: 'Running the app typecheck to see what still needs updating:', timestamp: '2026-10-05T10:02:00Z' },
    { type: 'thought' as const, content: 'The proxy now works without signing in. Final results: 160/160 tests pass.', timestamp: '2026-10-05T10:03:00Z' },
  ];

  it("shows a finished run's closing message as the summary, not a mid-run step that says it is done", () => {
    render(<ThinkingLog events={events} />);
    expect(screen.getAllByText('SUMMARY')).toHaveLength(1);
    expect(screen.getByText(/The proxy now works without signing in/)).toBeVisible();
    expect(screen.queryByText(/Worker side is done/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /3 analysis steps/ })).toHaveAttribute('aria-expanded', 'false');
  });

  it('names no summary while the run is still streaming', () => {
    render(<ThinkingLog events={events} streaming />);
    expect(screen.queryByText('SUMMARY')).not.toBeInTheDocument();
  });
});
