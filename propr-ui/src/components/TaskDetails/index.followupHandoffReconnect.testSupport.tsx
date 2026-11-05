import { expect, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import TaskDetails from './index';
import { AuthProvider } from '../../contexts/AuthContext';
import type { CurrentUser, FollowupRunsResponse, PostFollowupResponse } from '../../api/proprTypes';
import { createElectronDesktopAdapters } from '../../desktop/electronAdapters';
import { bridgeFixture, fromProfile, storedProfile } from '../../desktop/electronAdapters.test-fixture';
import { HANDOFF_POLL_MS } from './useFollowupHandoff';

/** Shared by the follow-up handoff reconnect suites; each suite mocks the task view's data and children itself. */
export const SOURCE = 'failed-issue-run';
export const USER_ID = '297689653';
const user = (id: string) => ({ id, login: `user-${id}`, permissions: [] }) as unknown as CurrentUser;
export const accepted: PostFollowupResponse = {
  success: true, state: 'queued', jobId: 'issue-acme-widgets-32', posted: true, commentId: 500,
  sourceTaskId: SOURCE, intent: 'issue', issueNumber: 32, message: 'Retry queued on issue #32.',
};
export const runsOf = (runs: FollowupRunsResponse['runs']): FollowupRunsResponse => ({ sourceTaskId: SOURCE, commentId: 500, runs });

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

export const renderPage = (userId = USER_ID) => render(
  <AuthProvider user={user(userId)}>
    <MemoryRouter initialEntries={[`/tasks/${SOURCE}`]}>
      <Routes>
        <Route path="/tasks/:taskId" element={<TaskDetails taskId={SOURCE} />} />
      </Routes>
    </MemoryRouter>
  </AuthProvider>,
);

export const flush = () => act(async () => {});
export const poll = () => act(async () => { await vi.advanceTimersByTimeAsync(HANDOFF_POLL_MS); });
export const banner = () => screen.queryByTestId('followup-handoff');
export const handoffKeys = () => Object.keys(sessionStorage).filter(key => key.startsWith('propr.followupHandoff.v1'));

export async function postFollowup() {
  fireEvent.click(screen.getAllByRole('button', { name: 'Follow Up' })[0]);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Post Comment' })); });
}

export const expectOriginalUntouched = (loadedTaskIds: Array<string | undefined>) => {
  for (const status of screen.getAllByTestId('source-status')) expect(status).toHaveAttribute('data-status', 'failed');
  expect(screen.getByTestId('source-timeline')).toBeInTheDocument();
  expect(new Set(loadedTaskIds)).toEqual(new Set([SOURCE]));
};

/**
 * The desktop's own activation path: every activation of a saved profile gets
 * a new transport generation, as the credential service issues one, and a
 * renewal of the same identity keeps this tab's session storage.
 */
export function desktopConnection() {
  const fixture = bridgeFixture();
  const adapters = createElectronDesktopAdapters(fixture.bridge);
  const otherProfile = { ...storedProfile, id: 'profile-2', label: 'Second server' };
  // Activation clears the renderer's state for a replaced identity before the new connection is published.
  const activate = async (transportScope: string, stored = storedProfile, identityEpoch = 'AAAAAAAAAAAAAAAAAAAAAA') => {
    fixture.activate.mockResolvedValueOnce({ status: 'ready', profileId: stored.id, transportScope, identityEpoch });
    const profile = fromProfile(stored);
    let activated!: Awaited<ReturnType<NonNullable<typeof adapters.connection.activate>>>;
    await act(async () => {
      activated = await adapters.connection.activate!(profile, { status: 'ready', version: '0.8.15', activationTicket: `ticket-${transportScope}` });
    });
    if (activated.status !== 'ready') throw new Error(`activation was ${activated.status}`);
    const ready = activated;
    return () => act(async () => {
      adapters.connection.publishActivation!(profile, ready);
      await fixture.bridge.profiles.setActive(stored.id);
    });
  };
  const connect = async (...args: Parameters<typeof activate>) => { await (await activate(...args))(); };
  const disconnect = () => act(() => adapters.connection.deactivate!());
  return { activate, connect, disconnect, otherProfile };
}

