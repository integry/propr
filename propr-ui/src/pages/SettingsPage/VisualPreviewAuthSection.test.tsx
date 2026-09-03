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
      canUseCurrentLogin: true,
    });
    render(<VisualPreviewAuthSection />);

    fireEvent.click(await screen.findByRole('button', { name: 'Use my GitHub login' }));
    await waitFor(() => expect(useCurrentLogin).toHaveBeenCalledOnce());
    expect(await screen.findByText(/Uploads use the GitHub login for @admin/)).toBeInTheDocument();
  });

  it('offers a fresh GitHub sign-in when the session token is incompatible', async () => {
    getStatus.mockResolvedValue({
      configured: true,
      source: 'github',
      status: 'reauth_required',
      githubUsername: 'admin',
      currentUsername: 'admin',
      canUseCurrentLogin: true,
    });
    render(<VisualPreviewAuthSection />);

    fireEvent.click(await screen.findByRole('button', { name: 'Sign in with GitHub again' }));
    expect(logout).toHaveBeenCalledOnce();
  });

  it('shows environment-managed credentials without replacement controls', async () => {
    getStatus.mockResolvedValue({
      configured: true,
      source: 'environment',
      status: 'active',
      currentUsername: 'admin',
      canUseCurrentLogin: true,
    });
    render(<VisualPreviewAuthSection />);

    expect(await screen.findByText(/server-managed credential/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Use my GitHub login' })).not.toBeInTheDocument();
    expect(disconnectVisualPreviewAuth).not.toHaveBeenCalled();
  });
});
