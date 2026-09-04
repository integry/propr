import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import VisualPreviewAuthSection from './VisualPreviewAuthSection';
import {
  disconnectVisualPreviewAuth,
  getVisualPreviewAuthStatus,
  connectCurrentGitHubLoginForVisualPreviews,
  connectVisualPreviewPersonalAccessToken,
} from '../../api/visualPreviewAuthApi';

vi.mock('../../api/visualPreviewAuthApi', () => ({
  disconnectVisualPreviewAuth: vi.fn(),
  getVisualPreviewAuthStatus: vi.fn(),
  connectCurrentGitHubLoginForVisualPreviews: vi.fn(),
  connectVisualPreviewPersonalAccessToken: vi.fn(),
}));

const getStatus = vi.mocked(getVisualPreviewAuthStatus);
const useCurrentLogin = vi.mocked(connectCurrentGitHubLoginForVisualPreviews);
const usePersonalAccessToken = vi.mocked(connectVisualPreviewPersonalAccessToken);

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

    expect(await screen.findByText(/GitHub App token/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Use my GitHub login' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add personal access token' })).toBeInTheDocument();
  });

  it('validates and stores a personal access token without rendering it afterward', async () => {
    usePersonalAccessToken.mockResolvedValue({
      configured: true,
      source: 'static_token',
      status: 'active',
      githubUsername: 'preview-bot',
      currentUsername: 'admin',
      currentLoginTokenType: 'github_app_user',
      canUseCurrentLogin: false,
    });
    render(<VisualPreviewAuthSection />);

    fireEvent.click(await screen.findByRole('button', { name: 'Add personal access token' }));
    const input = screen.getByLabelText('GitHub personal access token');
    fireEvent.change(input, { target: { value: 'github_pat_preview-secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save token' }));

    await waitFor(() => expect(usePersonalAccessToken).toHaveBeenCalledWith('github_pat_preview-secret'));
    expect(await screen.findByText(/owned by @preview-bot/)).toBeInTheDocument();
    expect(screen.queryByDisplayValue('github_pat_preview-secret')).not.toBeInTheDocument();
  });

  it('shows the exact GitHub permissions needed for preview uploads', async () => {
    render(<VisualPreviewAuthSection />);

    fireEvent.click(await screen.findByRole('button', { name: 'Add personal access token' }));

    expect(screen.getByText('Fine-grained token requirements')).toBeInTheDocument();
    expect(screen.getByText('Pull requests')).toBeInTheDocument();
    expect(screen.getByText('Read and write')).toBeInTheDocument();
    expect(screen.getByText(/Use an account with push access/)).toBeInTheDocument();
    expect(screen.getByText(/organization approval or SAML SSO authorization/)).toBeInTheDocument();
    expect(screen.getByText(/classic token with/)).toHaveTextContent('repo');
    expect(screen.getByText(/classic token with/)).toHaveTextContent('public_repo');

    const createTokenLink = screen.getByRole('link', { name: 'Create token on GitHub' });
    expect(createTokenLink).toHaveAttribute('href', expect.stringContaining('pull_requests=write'));
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
