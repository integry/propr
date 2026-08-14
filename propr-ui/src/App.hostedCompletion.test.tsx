import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';

const runtimeConfigMock = vi.hoisted(() => ({
  hostedUiConnectionIssue: vi.fn(),
  isHostedOAuthCompletionRoute: vi.fn(),
}));

const apiMock = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  getDemoModeStatus: vi.fn(),
}));

const compatibilityMock = vi.hoisted(() => ({
  checkProprApiCompatibility: vi.fn(),
}));

const ioMock = vi.hoisted(() => vi.fn(() => ({
  on: vi.fn(),
  disconnect: vi.fn(),
})));

vi.mock('./config/runtimeConfig', () => ({
  getApiBaseUrl: vi.fn(() => ''),
  hostedUiConnectionIssue: runtimeConfigMock.hostedUiConnectionIssue,
  isHostedOAuthCompletionRoute: runtimeConfigMock.isHostedOAuthCompletionRoute,
  isHostedUiOrigin: vi.fn(() => true),
  pathWithActiveHostedTunnelFlow: vi.fn((path: string) => path),
}));

vi.mock('./api/proprApi', () => ({
  INSTANCE_AUTHORIZATION_CHANGED_EVENT: 'propr:instance-authorization-changed',
  getCurrentUser: apiMock.getCurrentUser,
  getDemoModeStatus: apiMock.getDemoModeStatus,
}));

vi.mock('./api/compatibility', () => ({
  ProprCompatibilityCheckError: Error,
  checkProprApiCompatibility: compatibilityMock.checkProprApiCompatibility,
}));

vi.mock('socket.io-client', () => ({
  io: ioMock,
}));

describe('hosted OAuth completion route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.pushState(null, '', '/');
    runtimeConfigMock.isHostedOAuthCompletionRoute.mockImplementation(
      (_hostname: string, pathname: string, search: string) =>
        pathname === '/login' && new URLSearchParams(search).get('oauth_complete') === 'true'
    );
    runtimeConfigMock.hostedUiConnectionIssue.mockReturnValue({
      title: 'Connect a ProPR stack',
      message: 'This hosted UI needs a selected local stack before it can make API calls.',
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('renders the inert completion message without mounting hosted API or socket gates', () => {
    window.history.pushState(null, '', '/login?oauth_complete=true&flow=attacker');

    render(<App />);

    expect(screen.getByRole('heading', { name: 'GitHub sign-in complete' })).toBeInTheDocument();
    expect(screen.getByText('You can close this window and return to ProPR.')).toBeInTheDocument();
    expect(runtimeConfigMock.hostedUiConnectionIssue).not.toHaveBeenCalled();
    expect(compatibilityMock.checkProprApiCompatibility).not.toHaveBeenCalled();
    expect(apiMock.getDemoModeStatus).not.toHaveBeenCalled();
    expect(apiMock.getCurrentUser).not.toHaveBeenCalled();
    expect(ioMock).not.toHaveBeenCalled();
  });

  it('keeps other direct hosted login visits blocked when no tunnel is selected', () => {
    window.history.pushState(null, '', '/login?oauth_complete=false');

    render(<App />);

    expect(screen.getByRole('heading', { name: 'Connect a ProPR stack' })).toBeInTheDocument();
    expect(runtimeConfigMock.hostedUiConnectionIssue).toHaveBeenCalledTimes(1);
    expect(compatibilityMock.checkProprApiCompatibility).not.toHaveBeenCalled();
    expect(apiMock.getDemoModeStatus).not.toHaveBeenCalled();
    expect(apiMock.getCurrentUser).not.toHaveBeenCalled();
    expect(ioMock).not.toHaveBeenCalled();
  });
});
