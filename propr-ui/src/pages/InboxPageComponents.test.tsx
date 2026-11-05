import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { InboxState } from './InboxPageComponents';

describe('InboxState', () => {
  it.each([
    ['error', 'Couldn’t load your Inbox', 'Your notifications could not be read. Try again in a moment.'],
    ['offline', 'Inbox unavailable offline', 'Reconnect to see your latest notifications.'],
    ['empty', 'You’re all caught up', 'New operational updates will appear here.'],
  ] as const)('gives %s a sentence of its own when the read sent no message', (kind, heading, copy) => {
    render(<InboxState kind={kind} onRefresh={() => {}} />);
    expect(screen.getByRole('heading', { name: heading })).toBeInTheDocument();
    expect(screen.getByText(copy)).toBeInTheDocument();
    expect(screen.queryByText(/Fetching/)).not.toBeInTheDocument();
  });

  it('prefers the read’s own message, and ignores an empty one', () => {
    const { rerender } = render(<InboxState kind="error" message="Server returned 503" onRefresh={() => {}} />);
    expect(screen.getByText('Server returned 503')).toBeInTheDocument();
    rerender(<InboxState kind="error" message="" onRefresh={() => {}} />);
    expect(screen.getByText('Your notifications could not be read. Try again in a moment.')).toBeInTheDocument();
  });
});
