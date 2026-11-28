import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { getCurrentUser } from '../api/proprApi';
import {
  cancelDeviceSignIn,
  DeviceSignInRequestError,
  getSignInMethod,
  pollDeviceSignIn,
  startDeviceSignIn,
} from '../api/deviceSignInApi';
import LoginPage from './LoginPage';

vi.mock('../hooks/useDocumentTitle', () => ({ useDocumentTitle: vi.fn() }));
vi.mock('../contexts/DemoModeContext', () => ({ useDemoMode: () => ({ isDemoMode: false, isLoading: false }) }));
vi.mock('../api/proprApi', () => ({ API_BASE_URL: '', getCurrentUser: vi.fn() }));
const refreshCurrentUser = vi.fn(async () => undefined);
vi.mock('../contexts/AuthContext', () => ({ useRefreshCurrentUser: () => refreshCurrentUser }));
vi.mock('../api/deviceSignInApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/deviceSignInApi')>();
  return {
    ...actual,
    getSignInMethod: vi.fn(),
    startDeviceSignIn: vi.fn(),
    pollDeviceSignIn: vi.fn(),
    cancelDeviceSignIn: vi.fn(async () => undefined),
  };
});

const START = {
  attempt: 'attempt-1',
  userCode: 'WDJB-MJHT',
  verificationUri: 'https://github.com/login/device',
  expiresAt: '2026-11-28T10:15:00Z',
  interval: 5,
};

const renderLogin = (entry = '/login?logged_out=true') => render(
  <MemoryRouter initialEntries={[entry]}>
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/" element={<div>dashboard</div>} />
    </Routes>
  </MemoryRouter>,
);

/** The device panel's button, once the sign-in method has arrived. */
const deviceButton = async () => {
  await waitFor(() => expect(document.querySelector('[data-sign-in="device"]')).not.toBeNull());
  return screen.getByRole('button', { name: 'Sign in with GitHub' });
};

describe('LoginPage device sign-in', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(getCurrentUser).mockRejectedValue(new Error('Authentication required'));
    vi.mocked(getSignInMethod).mockResolvedValue('device');
    vi.mocked(startDeviceSignIn).mockResolvedValue(START);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.resetAllMocks();
  });

  it('shows the code, a copy button and the GitHub link, waits, then opens the dashboard', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    vi.mocked(pollDeviceSignIn)
      .mockResolvedValueOnce({ status: 'pending', interval: 5, retryAfterMs: 5_000 })
      .mockResolvedValueOnce({ status: 'complete' });

    renderLogin();
    fireEvent.click(await deviceButton());

    expect(await screen.findByLabelText('GitHub sign-in code')).toHaveTextContent('WDJB-MJHT');
    expect(screen.getByRole('link', { name: /Open github.com\/login\/device/ })).toHaveAttribute('href', 'https://github.com/login/device');
    expect(screen.getByText(/Waiting for you to approve/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('WDJB-MJHT'));
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();

    // No poll before GitHub's interval.
    expect(pollDeviceSignIn).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(pollDeviceSignIn).toHaveBeenCalledWith('attempt-1');
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });

    expect(await screen.findByText('dashboard')).toBeInTheDocument();
    expect(refreshCurrentUser).toHaveBeenCalled();
  });

  it('explains an expired device sign-in above the device panel', async () => {
    renderLogin('/login?error=device_sign_in_expired');
    expect(await screen.findByRole('alert')).toHaveTextContent('Your GitHub sign-in expired. Sign in again with a new code.');
    fireEvent.click(await deviceButton());
    expect(await screen.findByLabelText('GitHub sign-in code')).toHaveTextContent('WDJB-MJHT');
  });

  it('shows GitHub failures and lets the user start again', async () => {
    vi.mocked(pollDeviceSignIn).mockResolvedValueOnce({ status: 'failed', error: 'access_denied', message: 'GitHub sign-in was cancelled.' });

    renderLogin();
    fireEvent.click(await deviceButton());
    await screen.findByLabelText('GitHub sign-in code');
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });

    expect(await screen.findByRole('alert')).toHaveTextContent('GitHub sign-in was cancelled.');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(startDeviceSignIn).toHaveBeenCalledTimes(2));
  });

  it('explains when Device Flow is not enabled on the App', async () => {
    vi.mocked(startDeviceSignIn).mockRejectedValue(
      new DeviceSignInRequestError('device_flow_disabled', "Device sign-in isn't enabled for this GitHub App."),
    );
    renderLogin();
    fireEvent.click(await deviceButton());
    expect(await screen.findByRole('alert')).toHaveTextContent("Device sign-in isn't enabled for this GitHub App.");
  });

  it('cancels the attempt', async () => {
    renderLogin();
    fireEvent.click(await deviceButton());
    await screen.findByLabelText('GitHub sign-in code');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(cancelDeviceSignIn).toHaveBeenCalledWith('attempt-1');
    expect(screen.queryByLabelText('GitHub sign-in code')).not.toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(pollDeviceSignIn).not.toHaveBeenCalled();
  });

  it('starts a retry only after the cancel has reached the API', async () => {
    let finishCancel!: () => void;
    vi.mocked(cancelDeviceSignIn).mockImplementationOnce(() => new Promise<void>(resolve => { finishCancel = resolve; }));
    renderLogin();
    fireEvent.click(await deviceButton());
    await screen.findByLabelText('GitHub sign-in code');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(cancelDeviceSignIn).toHaveBeenCalledWith('attempt-1');

    vi.mocked(startDeviceSignIn).mockResolvedValue({ ...START, attempt: 'attempt-2', userCode: 'NEWR-CODE' });
    fireEvent.click(await deviceButton());
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(startDeviceSignIn).toHaveBeenCalledTimes(1);

    await act(async () => { finishCancel(); });
    expect(await screen.findByLabelText('GitHub sign-in code')).toHaveTextContent('NEWR-CODE');
    expect(startDeviceSignIn).toHaveBeenCalledTimes(2);
  });

  it('keeps the redirect sign-in for other modes', async () => {
    vi.mocked(getSignInMethod).mockResolvedValue('github');
    renderLogin();
    await screen.findByRole('button', { name: 'Sign in with GitHub' });
    await waitFor(() => expect(getSignInMethod).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with GitHub' }));
    expect(startDeviceSignIn).not.toHaveBeenCalled();
  });
});
