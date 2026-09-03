import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import VisualPreviewAuthSection from './VisualPreviewAuthSection';
import {
  disconnectVisualPreviewAuth,
  getVisualPreviewAuthStatus,
  connectCurrentGitHubLoginForVisualPreviews,
} from '../../api/visualPreviewAuthApi';
import { logout } from '../../api/proprApi';

vi.mock('../../api/visualPreviewAuthApi', () => ({
  disconnectVisualPreviewAuth: vi.fn(),
  getVisualPreviewAuthStatus: vi.fn(),
  connectCurrentGitHubLoginForVisualPreviews: vi.fn(),
}));
vi.mock('../../api/proprApi', () => ({ logout: vi.fn() }));

const getStatus = vi.mocked(getVisualPreviewAuthStatus);
const useCurrentLogin = vi.mocked(connectCurrentGitHubLoginForVisualPreviews);

describe('VisualPreviewAuthSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getStatus.mockResolvedValue({
      configured: false,
      status: 'missing',
      currentUsername: 'admin',
      currentLoginTokenType: 'supported',
      canUseCurrentLogin: true,
    });
  });

  it('connects the current administrator GitHub login', async () => {
    useCurrentLogin.mockResolvedValue({
      configured: true,
      source: 'github',
      status: 'active',
      githubUsername: 'admin',
      currentUsername: 'admin',
      currentLoginTokenType: 'supported',
      canUseCurrentLogin: true,
    });
    render(<VisualPreviewAuthSection />);

    fireEvent.click(await screen.findByRole('button', { name: 'Use my GitHub login' }));
    await waitFor(() => expect(useCurrentLogin).toHaveBeenCalledOnce());
    expect(await screen.findByText(/Uploads use the GitHub login for @admin/)).toBeInTheDocument();
  });

  it('replaces an expired stored credential when the current login is supported', async () => {
    getStatus.mockResolvedValue({
      configured: true,
      source: 'github',
      status: 'reauth_required',
      githubUsername: 'admin',
      currentUsername: 'admin',
      currentLoginTokenType: 'supported',
      canUseCurrentLogin: true,
    });
    useCurrentLogin.mockResolvedValue({
      configured: true,
      source: 'github',
      status: 'active',
      githubUsername: 'admin',
      currentUsername: 'admin',
      currentLoginTokenType: 'supported',
      canUseCurrentLogin: true,
    });
    render(<VisualPreviewAuthSection />);

    fireEvent.click(await screen.findByRole('button', { name: 'Use my GitHub login' }));
    await waitFor(() => expect(useCurrentLogin).toHaveBeenCalledOnce());
    expect(logout).not.toHaveBeenCalled();
  });

  it('explains that repeating a GitHub App login cannot enable uploads', async () => {
    getStatus.mockResolvedValue({
      configured: false,
      status: 'missing',
      currentUsername: 'admin',
      currentLoginTokenType: 'github_app_user',
      canUseCurrentLogin: false,
    });
    render(<VisualPreviewAuthSection />);

    expect(await screen.findByText(/GitHub App user token/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Use my GitHub login' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign in with GitHub again' })).not.toBeInTheDocument();
  });

  it('shows environment-managed credentials without replacement controls', async () => {
    getStatus.mockResolvedValue({
      configured: true,
      source: 'environment',
      status: 'active',
      currentUsername: 'admin',
      currentLoginTokenType: 'github_app_user',
      canUseCurrentLogin: true,
    });
    render(<VisualPreviewAuthSection />);

    expect(await screen.findByText(/server-managed credential/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Use my GitHub login' })).not.toBeInTheDocument();
    expect(disconnectVisualPreviewAuth).not.toHaveBeenCalled();
  });
});
