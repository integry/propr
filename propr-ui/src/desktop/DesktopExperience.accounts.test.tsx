import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { adaptersFor, deferred, renderConnectedExperience, remoteProfile } from './DesktopExperience.testSupport';
import type { DesktopConnectionResult } from './types';

const alice = { ...remoteProfile, id: 'alice', account: { id: '101', username: 'alice', avatarUrl: null } };
const bob = { ...remoteProfile, id: 'bob', account: { id: '202', username: 'bob', avatarUrl: null } };

it('shows a safe fallback when a saved account avatar fails in the chooser', async () => {
  const account = { ...alice.account, avatarUrl: 'https://avatars.githubusercontent.com/u/101?broken=1' };
  const adapters = adaptersFor([{ ...alice, account }]);
  adapters.savedAccounts = true;
  renderConnectedExperience(adapters);

  const identity = (await screen.findByText('@alice')).parentElement!;
  const image = identity.querySelector('img');
  expect(image).toHaveAttribute('src', account.avatarUrl);

  fireEvent.error(image!);

  expect(identity.querySelector('img')).not.toBeInTheDocument();
  expect(identity).toHaveTextContent('AL@alice');
});

it('shows both users at one instance and adds an account with a fresh binding', async () => {
  const adapters = adaptersFor([alice, bob]);
  adapters.savedAccounts = true;
  adapters.connection.deactivate = vi.fn();
  renderConnectedExperience(adapters);
  expect(await screen.findByText('@alice')).toBeInTheDocument();
  expect(screen.getByText('@bob')).toBeInTheDocument();
  fireEvent.click(screen.getAllByRole('button', { name: 'Add GitHub account to Team server' })[0]);
  await waitFor(() => expect(adapters.connection.probe).toHaveBeenCalled());
  const candidate = vi.mocked(adapters.connection.probe).mock.calls[0][0];
  expect(candidate.id).not.toBe(alice.id);
  expect(candidate.id).not.toBe(bob.id);
  expect(candidate.baseUrl).toBe(alice.baseUrl);
  expect(candidate.account).toBeUndefined();
  expect(adapters.profiles.setActiveId).toHaveBeenCalledWith(null);
});

it('clears active selection before a pending switch and unmounts old account data', async () => {
  const pending = deferred<DesktopConnectionResult>();
  const adapters = adaptersFor([alice, bob], alice.id, async p => p.id === alice.id ? { status: 'ready' } : pending.promise);
  adapters.savedAccounts = true;
  adapters.connection.deactivate = vi.fn();
  renderConnectedExperience(adapters, 'Alice private data');
  await screen.findByText('Alice private data');
  fireEvent.click(screen.getByRole('button', { name: 'Connected: Team server' }));
  fireEvent.click(screen.getByText('@bob').closest('button')!);
  await waitFor(() => expect(adapters.connection.probe).toHaveBeenCalledWith(bob));
  expect(screen.queryByText('Alice private data')).not.toBeInTheDocument();
  expect(vi.mocked(adapters.profiles.setActiveId).mock.calls.at(-1)).toEqual([null]);
  await act(async () => pending.resolve({ status: 'authentication-required' }));
  expect(screen.queryByText('Alice private data')).not.toBeInTheDocument();
});
