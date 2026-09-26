import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { CurrentUser } from '../api/proprTypes';
import UserAvatar from './UserAvatar';

const user: CurrentUser = {
  id: 'user-1',
  login: 'octocat',
  username: 'octocat',
  displayName: 'The Octocat',
  email: null,
  avatarUrl: 'https://avatars.githubusercontent.com/u/583231?v=4',
  role: 'admin',
  permissions: [],
  authorizationSource: 'local',
};

const renderAvatar = (currentUser = user) => render(
  <UserAvatar user={currentUser} className="avatar" fallbackClassName="fallback" referrerPolicy="no-referrer" />
);

describe('UserAvatar', () => {
  it('replaces a failed image with accessible initials without changing its layout classes', () => {
    renderAvatar();

    const image = screen.getByRole('img', { name: 'The Octocat avatar' });
    expect(image).toHaveAttribute('src', user.avatarUrl);
    expect(image).toHaveAttribute('referrerpolicy', 'no-referrer');

    fireEvent.error(image);

    const fallback = screen.getByRole('img', { name: 'The Octocat avatar' });
    expect(fallback.tagName).toBe('DIV');
    expect(fallback).toHaveClass('avatar', 'fallback');
    expect(fallback).toHaveTextContent('OC');
    expect(screen.queryByAltText('The Octocat avatar')).not.toBeInTheDocument();
  });

  it('tries the image again when the avatar URL or account identity changes', () => {
    const { rerender } = renderAvatar();
    fireEvent.error(screen.getByRole('img', { name: 'The Octocat avatar' }));

    const recoveredUser = {
      ...user,
      avatarUrl: 'https://avatars.githubusercontent.com/u/583231?v=5',
    };
    rerender(<UserAvatar user={recoveredUser} className="avatar" fallbackClassName="fallback" />);
    expect(screen.getByRole('img', { name: 'The Octocat avatar' })).toHaveAttribute(
      'src',
      recoveredUser.avatarUrl
    );

    rerender(<UserAvatar
      user={{
        ...user,
        id: 'user-2',
        username: 'hubot',
        displayName: 'Hubot',
      }}
      className="avatar"
      fallbackClassName="fallback"
    />);
    expect(screen.getByRole('img', { name: 'Hubot avatar' })).toHaveAttribute('src', user.avatarUrl);

    rerender(<UserAvatar user={{ ...user, avatarUrl: null }} className="avatar" />);
    expect(screen.getByRole('img', { name: 'The Octocat avatar' }).tagName).toBe('DIV');
    rerender(<UserAvatar user={user} className="avatar" />);
    expect(screen.getByRole('img', { name: 'The Octocat avatar' })).toHaveAttribute('src', user.avatarUrl);
  });
});
