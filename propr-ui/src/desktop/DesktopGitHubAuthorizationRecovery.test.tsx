import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleApiResponse, setDesktopConnectionScope } from '../api/apiClient';
import { Zap } from 'lucide-react';
import { CreationDialog } from '../components/CreationDialog';
import { DesktopExperience } from './DesktopExperience';
import { DesktopGitHubAuthorizationRecovery } from './DesktopGitHubAuthorizationRecovery';
import { adaptersFor, remoteProfile } from './DesktopExperience.testSupport';
import { DESKTOP_GITHUB_AUTHORIZATION_REQUIRED_EVENT } from './types';

const requireGrant = (profileId = remoteProfile.id, transportScope = 'current-scope') => act(() => {
  window.dispatchEvent(new CustomEvent(DESKTOP_GITHUB_AUTHORIZATION_REQUIRED_EVENT, {
    detail: { profileId, transportScope, code: 'GITHUB_REAUTH_REQUIRED' },
  }));
});

describe('Desktop GitHub grant recovery', () => {
  afterEach(() => setDesktopConnectionScope(null));

  it('connects API grant failures to the notice while leaving the task mounted', async () => {
    const adapters = adaptersFor([remoteProfile], remoteProfile.id, async () => ({ status: 'ready', transportScope: 'current-scope' }));
    const closeTask = vi.fn();
    // Flush startup effects too: the task can appear before the recovery listener
    // is attached, so finding its input alone is not a readiness boundary.
    await act(async () => {
      render(<DesktopExperience adapters={adapters}><CreationDialog title="New task" icon={Zap} description="Describe your task" closeLabel="Close task" onClose={closeTask}><input aria-label="Original task" defaultValue="Work in progress" /></CreationDialog></DesktopExperience>);
    });
    const dialog = screen.getByRole('dialog', { name: 'New task' });
    const task = within(dialog).getByRole('textbox', { name: 'Original task' });
    fireEvent.change(task, { target: { value: 'Updated work in progress' } });
    const invalidate = vi.fn();
    setDesktopConnectionScope({ bridge: { connection: { invalidate } } as never, profileId: remoteProfile.id, transportScope: 'current-scope' });
    await act(async () => {
      await expect(handleApiResponse(new Response(JSON.stringify({ code: 'GITHUB_REAUTH_REQUIRED' }), { status: 403 }))).rejects.toThrow('GitHub authorization');
    });
    expect(screen.getByRole('dialog', { name: 'New task' })).toBe(dialog);
    const notice = within(dialog).getByRole('region', { name: 'Authorize GitHub repository access' });
    expect(notice).toBeVisible();
    expect(within(notice).getByRole('heading', { name: 'Authorize GitHub repository access' })).toBeVisible();
    expect(within(notice).getByRole('button', { name: 'Sign in with GitHub in browser' })).toBeEnabled();
    expect(within(dialog).getByRole('textbox', { name: 'Original task' })).toBe(task);
    expect(task).toHaveValue('Updated work in progress');
    fireEvent.keyDown(within(notice).getByRole('button', { name: 'Return to my action' }), { key: 'Escape' });
    expect(closeTask).not.toHaveBeenCalled();
    expect(within(dialog).queryByRole('region', { name: 'Authorize GitHub repository access' })).not.toBeInTheDocument();
    expect(within(dialog).getByRole('textbox', { name: 'Original task' })).toBe(task);
    expect(task).toHaveValue('Updated work in progress');
    expect(invalidate).not.toHaveBeenCalled();
    expect(adapters.authentication.authenticate).not.toHaveBeenCalled();
  });

  it('starts fresh instance OAuth without pairing or losing the original action', async () => {
    const adapters = adaptersFor();
    render(<>
      <input aria-label="Task description" defaultValue="Fix the acceptance issue" />
      <DesktopGitHubAuthorizationRecovery adapters={adapters} profile={{ ...remoteProfile, account: { id: '123', username: 'desktop-user', avatarUrl: null } }} transportScope="current-scope" />
    </>);
    requireGrant();
    expect(screen.getByText('@desktop-user')).toBeInTheDocument();
    expect(screen.getByText(/Pairing again does not renew/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with GitHub in browser' }));
    expect(await screen.findByRole('button', { name: 'Sign in with GitHub in browser' })).toBeEnabled();
    expect(adapters.externalBrowser.open).toHaveBeenCalledExactlyOnceWith('https://propr.example.com/api/auth/github');
    expect(adapters.authentication.authenticate).not.toHaveBeenCalled();
    expect(adapters.connection.probe).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Return to my action' }));
    expect(screen.getByLabelText('Task description')).toHaveValue('Fix the acceptance issue');
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
    requireGrant();
    expect(screen.getByRole('region')).toBeInTheDocument();
  });

  it('starts recovery from a saved loopback native profile origin and keeps renewal guidance truthful', async () => {
    const adapters = adaptersFor();
    const nativeProfile = { ...remoteProfile, baseUrl: 'http://127.0.0.1:4000' };
    render(<>
      <input aria-label="Task description" defaultValue="Review PR #18" />
      <DesktopGitHubAuthorizationRecovery adapters={adapters} profile={nativeProfile} transportScope="current-scope" />
    </>);
    requireGrant();
    expect(screen.getByText(/browser dashboard does not by itself renew authorization/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with GitHub in browser' }));
    expect(await screen.findByRole('button', { name: 'Sign in with GitHub in browser' })).toBeEnabled();
    // The API moves this alias to the configured callback origin before creating OAuth state.
    expect(adapters.externalBrowser.open).toHaveBeenCalledExactlyOnceWith('http://127.0.0.1:4000/api/auth/github');
    expect(adapters.authentication.authenticate).not.toHaveBeenCalled();
    expect(screen.getByRole('region', { name: 'Authorize GitHub repository access' })).toBeInTheDocument();
    expect(screen.getByLabelText('Task description')).toHaveValue('Review PR #18');
  });

  it('ignores another account and stale transport scopes', () => {
    render(<DesktopGitHubAuthorizationRecovery adapters={adaptersFor()} profile={remoteProfile} transportScope="current-scope" />);
    requireGrant('another-account');
    requireGrant(remoteProfile.id, 'previous-scope');
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
  });

  it('offers retry on browser failure without exposing host error details', async () => {
    const adapters = adaptersFor();
    vi.mocked(adapters.externalBrowser.open).mockRejectedValueOnce(new Error('secret-host-sentinel'));
    render(<DesktopGitHubAuthorizationRecovery adapters={adapters} profile={remoteProfile} transportScope="current-scope" />);
    requireGrant();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with GitHub in browser' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not open GitHub sign-in');
    expect(document.body).not.toHaveTextContent('secret-host-sentinel');
    expect(screen.getByRole('button', { name: 'Sign in with GitHub in browser' })).toBeEnabled();
  });

  it('shows the precise reason the instance reports for a Connect grant needing sign-in', async () => {
    const adapters = adaptersFor();
    render(<DesktopGitHubAuthorizationRecovery adapters={adapters} profile={remoteProfile} transportScope="current-scope" />);
    setDesktopConnectionScope({ bridge: { connection: { invalidate: vi.fn() } } as never, profileId: remoteProfile.id, transportScope: 'current-scope' });
    await act(async () => {
      await expect(handleApiResponse(new Response(JSON.stringify({ code: 'GITHUB_REAUTH_REQUIRED', reason: 'renewal_revoked' }), { status: 403 })))
        .rejects.toThrow('Your GitHub authorization for Connect was revoked. GitHub authorization is required.');
    });
    expect(screen.getByRole('region')).toHaveTextContent('Your GitHub authorization for Connect was revoked.');

    act(() => {
      window.dispatchEvent(new CustomEvent(DESKTOP_GITHUB_AUTHORIZATION_REQUIRED_EVENT, {
        detail: { profileId: remoteProfile.id, transportScope: 'current-scope', code: 'GITHUB_REAUTH_REQUIRED', reason: 'missing_refresh_token' },
      }));
    });
    expect(screen.getByRole('region')).toHaveTextContent('Signing in again once gives this instance a renewable authorization.');

    // Unknown reasons fall back to the generic guidance only.
    act(() => {
      window.dispatchEvent(new CustomEvent(DESKTOP_GITHUB_AUTHORIZATION_REQUIRED_EVENT, {
        detail: { profileId: remoteProfile.id, transportScope: 'current-scope', code: 'GITHUB_REAUTH_REQUIRED', reason: '<script>' },
      }));
    });
    expect(screen.getByRole('region')).not.toHaveTextContent(/revoked|renewable/);
  });
});
