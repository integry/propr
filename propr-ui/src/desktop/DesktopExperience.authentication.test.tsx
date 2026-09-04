import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DesktopExperience } from './DesktopExperience';
import { adaptersFor, remoteProfile } from './DesktopExperience.testSupport';

const apiMock = vi.hoisted(() => ({ setApiBaseUrl: vi.fn() }));
const runtimeMock = vi.hoisted(() => ({ setDesktopApiBaseUrl: vi.fn() }));

vi.mock('../api/apiClient', () => ({ setApiBaseUrl: apiMock.setApiBaseUrl }));
vi.mock('../config/runtimeConfig', () => ({ setDesktopApiBaseUrl: runtimeMock.setDesktopApiBaseUrl }));

describe('DesktopExperience authentication', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reconnects after authentication completes and advances to the connected app', async () => {
    const probe = vi.fn()
      .mockResolvedValueOnce({ status: 'authentication-required', message: 'Please sign in.' })
      .mockResolvedValueOnce({ status: 'ready', version: '0.8.15' });
    const adapters = adaptersFor([remoteProfile], remoteProfile.id, probe);
    const stages: string[] = [];
    adapters.acceptance = {
      reportJourneyStage: vi.fn(async stage => { stages.push(stage); }),
    };
    render(<DesktopExperience adapters={adapters}><div>Connected app</div></DesktopExperience>);

    fireEvent.click(await screen.findByRole('button', { name: /Sign in in browser/i }));

    expect(await screen.findByText('Connected app')).toBeInTheDocument();
    expect(adapters.authentication.authenticate).toHaveBeenCalledWith(remoteProfile);
    expect(probe).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(stages).toEqual([
      'AUTHENTICATION_REQUIRED',
      'CREDENTIAL_COMMITTED',
      'AUTHENTICATED_REPROBE_READY',
      'ACTIVATION_COMMITTED',
      'ACTIVATION_PUBLISHED',
      'REACT_CONNECTED',
    ]));
  });

  it('reports rejected authentication and connection-help operations in the blocked panel', async () => {
    const adapters = adaptersFor(
      [remoteProfile],
      remoteProfile.id,
      async () => ({ status: 'authentication-required', message: 'Please sign in.' })
    );
    vi.mocked(adapters.authentication.authenticate).mockRejectedValueOnce(new Error('Browser launch failed.'));
    vi.mocked(adapters.externalBrowser.open).mockRejectedValueOnce(new Error('No browser is configured.'));
    render(<DesktopExperience adapters={adapters}><div>Connected app</div></DesktopExperience>);

    fireEvent.click(await screen.findByRole('button', { name: /Sign in in browser/i }));
    expect(await screen.findByText(/could not open sign in.*try again/i)).toBeInTheDocument();
    expect(screen.queryByText(/browser launch failed/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Sign in in browser/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Open connection help/i }));
    expect(await screen.findByText(/could not open connection help.*try again/i)).toBeInTheDocument();
    expect(screen.queryByText(/no browser is configured/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Open connection help/i })).toBeInTheDocument();
  });
});
