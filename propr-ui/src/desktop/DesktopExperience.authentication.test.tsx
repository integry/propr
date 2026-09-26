import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DesktopExperience } from './DesktopExperience';
import { DesktopInstanceSelector } from './DesktopInstanceSelector';
import { adaptersFor, remoteProfile } from './DesktopExperience.testSupport';
import { DesktopAuthenticationError, type DesktopAuthenticationProgressStage } from './types';

const apiMock = vi.hoisted(() => ({ setApiBaseUrl: vi.fn() }));
const runtimeMock = vi.hoisted(() => ({ setDesktopApiBaseUrl: vi.fn() }));

vi.mock('../api/apiClient', () => ({ setApiBaseUrl: apiMock.setApiBaseUrl }));
vi.mock('../config/runtimeConfig', () => ({ setDesktopApiBaseUrl: runtimeMock.setDesktopApiBaseUrl }));

describe('DesktopExperience authentication', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('publishes the connected renderer only after its authenticated transport is ready', async () => {
    const probe = vi.fn()
      .mockResolvedValueOnce({ status: 'authentication-required', message: 'Please sign in.' })
      .mockResolvedValueOnce({ status: 'ready', version: '0.8.15' });
    const adapters = adaptersFor([remoteProfile], remoteProfile.id, probe);
    const stages: string[] = [];
    adapters.acceptance = {
      reportJourneyStage: vi.fn(async stage => {
        if (stage === 'REACT_CONNECTED') {
          expect(document.querySelector('.desktop-instance-selector-button.desktop-connection-ready')).toBeInstanceOf(HTMLButtonElement);
        }
        stages.push(stage);
      }),
    };
    const connectedApp = (transportReady: boolean) => (
      <DesktopExperience adapters={adapters}>
        <DesktopInstanceSelector transportReady={transportReady} />
        <div>Connected app</div>
      </DesktopExperience>
    );
    const view = render(connectedApp(false));

    fireEvent.click(await screen.findByRole('button', { name: /Sign in in browser/i }));

    expect(await screen.findByText('Connected app')).toBeInTheDocument();
    expect(adapters.authentication.authenticate).toHaveBeenCalledWith(remoteProfile, expect.any(Function));
    expect(probe).toHaveBeenCalledTimes(2);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(stages).toEqual([
      'AUTHENTICATION_REQUIRED',
      'CREDENTIAL_COMMITTED',
      'AUTHENTICATED_REPROBE_READY',
      'ACTIVATION_COMMITTED',
      'ACTIVATION_PUBLISHED',
    ]);

    // Model the slower ARM64 ordering: React has committed the connected shell,
    // but authenticated REST and the scoped Socket.IO handshake complete later.
    view.rerender(connectedApp(true));
    await waitFor(() => expect(stages).toEqual([
      'AUTHENTICATION_REQUIRED',
      'CREDENTIAL_COMMITTED',
      'AUTHENTICATED_REPROBE_READY',
      'ACTIVATION_COMMITTED',
      'ACTIVATION_PUBLISHED',
      'REACT_CONNECTED',
    ]));
  });

  it('shows browser approval progress and keeps the user in control while pairing is pending', async () => {
    const adapters = adaptersFor(
      [remoteProfile],
      remoteProfile.id,
      async () => ({ status: 'authentication-required', message: 'Please sign in.' }),
    );
    let reportProgress: ((stage: DesktopAuthenticationProgressStage) => void) | undefined;
    let settlePairing: (() => void) | undefined;
    adapters.authentication.cancel = vi.fn(async () => undefined);
    vi.mocked(adapters.authentication.authenticate).mockImplementation((_profile, onProgress) => {
      reportProgress = onProgress;
      return new Promise<void>(resolve => { settlePairing = resolve; });
    });
    render(<DesktopExperience adapters={adapters}><div>Connected app</div></DesktopExperience>);

    fireEvent.click(await screen.findByRole('button', { name: /Sign in in browser/i }));
    expect(await screen.findByText(/preparing a secure browser approval request/i)).toBeInTheDocument();

    act(() => reportProgress?.('approval-pending'));
    expect(await screen.findByText(/finish signing in and approve ProPR Desktop/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Reopen browser/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Copy approval link/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Cancel sign in/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Copy approval link/i }));
    expect(await screen.findByRole('status')).toHaveTextContent('Approval link copied.');
    expect(adapters.authentication.copyApproval).toHaveBeenCalledWith(remoteProfile.id);

    vi.mocked(adapters.authentication.reopenApproval!).mockResolvedValueOnce({ status: 'failed' });
    fireEvent.click(screen.getByRole('button', { name: /Reopen browser/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not reopen.*default browser.*copy the link/i);
    expect(document.body).not.toHaveTextContent(/https?:\/\/|pairing_id|device_secret/i);

    fireEvent.click(screen.getByRole('button', { name: /Cancel sign in/i }));
    expect(await screen.findByRole('button', { name: /Sign in in browser/i })).toBeInTheDocument();
    expect(adapters.authentication.cancel).toHaveBeenCalledWith(remoteProfile.id);
    act(() => settlePairing?.());
  });

  it('explains an ambiguous Linux browser-launch rejection while approval remains pending', async () => {
    const adapters = adaptersFor(
      [remoteProfile],
      remoteProfile.id,
      async () => ({ status: 'authentication-required', message: 'Please sign in.' }),
    );
    vi.mocked(adapters.authentication.authenticate).mockImplementation(async (_profile, onProgress) => {
      onProgress?.('browser-open-failed');
      await new Promise<void>(() => undefined);
    });
    render(<DesktopExperience adapters={adapters}><div>Connected app</div></DesktopExperience>);

    fireEvent.click(await screen.findByRole('button', { name: /Sign in in browser/i }));

    expect(await screen.findByText(/could not confirm that your browser opened/i)).toBeInTheDocument();
    expect(screen.getByText(/if the approval page appeared, finish there/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Reopen browser/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Copy approval link/i })).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(/pairing_id|device_secret|xdg-open/i);
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
    expect(await screen.findByText(/pairing could not be completed.*try again/i)).toBeInTheDocument();
    expect(screen.queryByText(/browser launch failed/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Sign in in browser/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Open connection help/i }));
    expect(await screen.findByText(/could not open connection help.*try again/i)).toBeInTheDocument();
    expect(screen.queryByText(/no browser is configured/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Open connection help/i })).toBeInTheDocument();
  });

  it.each([
    ['APPROVAL_EXPIRED', /browser approval expired.*start sign in again/i],
    ['SECURE_STORAGE_FAILED', /could not save.*secure storage.*system keychain/i],
    ['PAIRING_UNREACHABLE', /instance became unreachable.*browser approval/i],
    ['PAIRING_REJECTED', /could not verify the pairing response.*endpoint/i],
  ] as const)('shows safe recovery for %s', async (code, message) => {
    const adapters = adaptersFor(
      [remoteProfile],
      remoteProfile.id,
      async () => ({ status: 'authentication-required', message: 'Please sign in.' }),
    );
    vi.mocked(adapters.authentication.authenticate).mockRejectedValueOnce(new DesktopAuthenticationError(code));
    render(<DesktopExperience adapters={adapters}><div>Connected app</div></DesktopExperience>);

    fireEvent.click(await screen.findByRole('button', { name: /Sign in in browser/i }));

    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Sign in in browser/i })).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(code);
  });
});
