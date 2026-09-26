import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { GitHubAccountIdentity } from './GitHubAccountIdentity';

const account = {
  id: '583231',
  username: 'octocat',
  avatarUrl: 'https://avatars.githubusercontent.com/u/583231?v=4',
};

describe('GitHubAccountIdentity', () => {
  it('replaces an avatar that fails to load with decorative initials', () => {
    const { container } = render(<GitHubAccountIdentity account={account} />);

    const image = container.querySelector('img');
    expect(image).toHaveAttribute('src', account.avatarUrl);
    expect(image).toHaveAttribute('referrerpolicy', 'no-referrer');

    fireEvent.error(image!);

    expect(container.querySelector('img')).not.toBeInTheDocument();
    expect(screen.getByText('OC')).toBeInTheDocument();
    expect(screen.getByText('OC').parentElement).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByText('@octocat')).toBeInTheDocument();
  });

  it('uses the same safe fallback when no avatar is available', () => {
    const { container } = render(
      <GitHubAccountIdentity account={{ ...account, avatarUrl: null }} />
    );

    expect(container.querySelector('img')).not.toBeInTheDocument();
    expect(screen.getByText('OC')).toBeInTheDocument();
  });
});
