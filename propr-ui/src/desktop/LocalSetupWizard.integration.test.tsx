import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopGithubInstallationDecision, DesktopSetupSnapshot } from '../../../apps/desktop/src/shared/contract';
import { DesktopExperience } from './DesktopExperience';
import { adaptersFor, localProfile } from './DesktopExperience.testSupport';
import { LocalSetupWizard } from './LocalSetupWizard';
import {
  completed,
  guidedAdapter,
  idle,
  openAndSubmitWizard,
} from './LocalSetupWizard.integration.testSupport';

const apiMock = vi.hoisted(() => ({ setApiBaseUrl: vi.fn() }));
const runtimeMock = vi.hoisted(() => ({ setDesktopApiBaseUrl: vi.fn() }));
vi.mock('../api/apiClient', () => ({ setApiBaseUrl: apiMock.setApiBaseUrl }));
vi.mock('../config/runtimeConfig', () => ({ setDesktopApiBaseUrl: runtimeMock.setDesktopApiBaseUrl }));

describe('production local setup journey', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows the authenticated identity, installation types, and explicit recovery controls', async () => {
    const choosing: DesktopSetupSnapshot = {
      ...idle, phase: 'running', githubIdentity: {
        status: 'authorization-failed', username: 'member-user', installAvailable: true,
        selectedInstallationId: '100',
        permissionExplanation: 'This account has access, but an installation owner must authorize enrollment.',
        installations: [
          { installationId: '100', accountLogin: 'acme', accountType: 'Organization' },
          { installationId: '200', accountLogin: 'member-user', accountType: 'User' },
        ],
      },
    };
    const resolveGithubInstallation = vi.fn(async () => ({
      ...choosing, githubIdentity: { ...choosing.githubIdentity!, status: 'enrolling' as const, selectedInstallationId: '200' },
    }));
    render(<LocalSetupWizard adapter={guidedAdapter({
      status: vi.fn(async () => choosing), resolveGithubInstallation,
    })} onBack={vi.fn()} onComplete={vi.fn()} />);

    expect(await screen.findByText('@member-user')).toBeInTheDocument();
    expect(screen.getByText('Organization · Installation 100')).toBeInTheDocument();
    expect(screen.getByText('User · Installation 200')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/installation owner/i);
    expect(screen.getByRole('radio', { name: /acme/i })).toBeChecked();
    expect(screen.getByRole('button', { name: 'Continue with selection' })).toBeEnabled();
    fireEvent.click(screen.getByRole('radio', { name: /member-user/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue with selection' }));
    expect(resolveGithubInstallation).toHaveBeenCalledWith({ action: 'select', installationId: '200' });
    expect(screen.getByRole('button', { name: 'Refresh installations' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Install GitHub App' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Change GitHub account' })).toBeInTheDocument();
  });

  it('requires a fresh choice after reauthentication even when identity metadata is unchanged', async () => {
    const choosing: DesktopSetupSnapshot = {
      ...idle, phase: 'running', githubIdentity: {
        status: 'authorization-failed', username: 'shared-user', installAvailable: true,
        selectedInstallationId: '100', installations: [
          { installationId: '100', accountLogin: 'shared-org', accountType: 'Organization' },
          { installationId: '200', accountLogin: 'shared-user', accountType: 'User' },
        ],
      },
    };
    const afterReauthentication: DesktopSetupSnapshot = {
      ...choosing, githubIdentity: {
        ...choosing.githubIdentity!, status: 'selection-required', selectedInstallationId: undefined,
      },
    };
    const resolveGithubInstallation = vi.fn(async (decision: DesktopGithubInstallationDecision) => decision.action === 'reauthenticate'
      ? afterReauthentication : choosing);
    render(<LocalSetupWizard adapter={guidedAdapter({
      status: vi.fn(async () => choosing), resolveGithubInstallation,
    })} onBack={vi.fn()} onComplete={vi.fn()} />);

    expect(await screen.findByRole('radio', { name: /shared-org/i })).toBeChecked();
    fireEvent.click(screen.getByRole('radio', { name: /shared-user/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Change GitHub account' }));

    await waitFor(() => expect(resolveGithubInstallation).toHaveBeenCalledWith({ action: 'reauthenticate' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Continue with selection' })).toBeDisabled());
    expect(screen.getAllByRole('radio').every(radio => !(radio as HTMLInputElement).checked)).toBe(true);
  });

  it('clears a local choice that disappears from a refreshed installation list', async () => {
    const choosing: DesktopSetupSnapshot = {
      ...idle, phase: 'running', githubIdentity: {
        status: 'selection-required', username: 'member-user', installAvailable: true,
        installations: [
          { installationId: '100', accountLogin: 'acme', accountType: 'Organization' },
          { installationId: '200', accountLogin: 'member-user', accountType: 'User' },
        ],
      },
    };
    const refreshed: DesktopSetupSnapshot = {
      ...choosing, githubIdentity: {
        ...choosing.githubIdentity!, installations: [choosing.githubIdentity!.installations[0]],
      },
    };
    const resolveGithubInstallation = vi.fn(async () => refreshed);
    render(<LocalSetupWizard adapter={guidedAdapter({
      status: vi.fn(async () => choosing), resolveGithubInstallation,
    })} onBack={vi.fn()} onComplete={vi.fn()} />);

    fireEvent.click(await screen.findByRole('radio', { name: /member-user/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh installations' }));

    await waitFor(() => {
      expect(screen.queryByRole('radio', { name: /member-user/i })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Continue with selection' })).toBeDisabled();
    });
    expect(screen.getByRole('radio', { name: /acme/i })).not.toBeChecked();
  });

  it('removes Demo and fixes ProPR Connect to readable WebSocket intake', async () => {
    render(<LocalSetupWizard adapter={guidedAdapter()} onBack={vi.fn()} onComplete={vi.fn()} />);

    await screen.findByRole('heading', { name: 'Check the essentials' });
    fireEvent.click(screen.getByRole('button', { name: /Continue/i }));
    fireEvent.click(screen.getByRole('button', { name: /Continue/i }));
    expect(await screen.findByRole('heading', { name: 'Connect GitHub' })).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: /Demo/i })).not.toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'ProPR Connect' })).toBeChecked();

    fireEvent.click(screen.getByRole('button', { name: /Continue/i }));
    expect(await screen.findByRole('heading', { name: 'GitHub event intake' })).toBeInTheDocument();
    expect(screen.getByText('ProPR Connect uses a persistent WebSocket connection for GitHub events.')).toBeInTheDocument();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
  });

  it('keeps Custom GitHub App polling and direct webhook choices readable', async () => {
    const adapter = guidedAdapter({
      selectPrivateKey: vi.fn(async () => ({ capability: 'private-key-capability-123456789012', label: 'github-app.pem' })),
    });
    render(<LocalSetupWizard adapter={adapter} onBack={vi.fn()} onComplete={vi.fn()} />);

    await screen.findByRole('heading', { name: 'Check the essentials' });
    fireEvent.click(screen.getByRole('button', { name: /Continue/i }));
    fireEvent.click(screen.getByRole('button', { name: /Continue/i }));
    fireEvent.click(await screen.findByRole('radio', { name: 'Custom GitHub App' }));
    fireEvent.change(screen.getByLabelText('App ID'), { target: { value: '123' } });
    fireEvent.change(screen.getByLabelText('Installation ID'), { target: { value: '456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Choose private key' }));
    await screen.findByText('github-app.pem');
    fireEvent.click(screen.getByRole('button', { name: /Continue/i }));

    expect(await screen.findByRole('heading', { name: 'GitHub event intake' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Polling' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Direct webhook' })).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: 'WebSocket' })).not.toBeInTheDocument();
  });

  it('opens the real wizard and settles cancellation before retrying', async () => {
    let progress: ((snapshot: DesktopSetupSnapshot) => void) | undefined;
    let settleStart: ((snapshot: DesktopSetupSnapshot) => void) | undefined;
    const start = vi.fn(async () => new Promise<DesktopSetupSnapshot>(resolve => {
      settleStart = resolve;
      progress?.({ ...idle, phase: 'running' });
    }));
    const cancelled = { ...idle, phase: 'cancelled' as const, error: 'Setup was cancelled safely.' };
    const cancel = vi.fn(async () => { settleStart?.(cancelled); return cancelled; });
    const retry = vi.fn(async () => completed);
    const adapter = guidedAdapter({
      start, cancel, retry,
      onProgress: vi.fn(listener => { progress = listener; return () => { progress = undefined; }; }),
    });
    const adapters = adaptersFor(); adapters.localSetup = adapter;
    render(<DesktopExperience adapters={adapters}><div>Dashboard</div></DesktopExperience>);

    await openAndSubmitWizard();
    expect(await screen.findByRole('heading', { name: 'Setting up ProPR' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Cancel safely/i }));
    expect(await screen.findByRole('heading', { name: 'Setup needs attention' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Retry setup/i }));
    expect(await screen.findByRole('heading', { name: 'ProPR is ready' })).toBeInTheDocument();
    expect(cancel).toHaveBeenCalledOnce();
    expect(retry).toHaveBeenCalledWith();
  });

  it('hands completion into pairing, authenticated reprobe, and the current dashboard flow', async () => {
    const adapters = adaptersFor();
    adapters.localSetup = guidedAdapter();
    vi.mocked(adapters.connection.probe)
      .mockResolvedValueOnce({ status: 'authentication-required', message: 'Pair this desktop.' })
      .mockResolvedValueOnce({ status: 'ready', version: '0.8.15' });
    render(<DesktopExperience adapters={adapters}><div>Authenticated dashboard</div></DesktopExperience>);

    await openAndSubmitWizard();
    fireEvent.click(await screen.findByRole('button', { name: /Connect securely/i }));
    expect(await screen.findByText('Sign in required')).toBeInTheDocument();
    expect(adapters.profiles.save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Sign in in browser/i }));

    expect(await screen.findByText('Authenticated dashboard')).toBeInTheDocument();
    expect(adapters.authentication.authenticate).toHaveBeenCalledWith(localProfile, expect.any(Function));
    expect(adapters.connection.probe).toHaveBeenCalledTimes(2);
    expect(adapters.profiles.save).toHaveBeenCalledWith(expect.objectContaining({ id: localProfile.id }));
    expect(adapters.profiles.setActiveId).toHaveBeenCalledWith(localProfile.id);
    expect(runtimeMock.setDesktopApiBaseUrl).toHaveBeenCalledWith(localProfile.baseUrl);
  });

  it('shows status failures with working back and retry actions', async () => {
    const adapter = guidedAdapter();
    vi.mocked(adapter.status).mockRejectedValueOnce(new Error('private status failure'));
    const onBack = vi.fn();
    render(<LocalSetupWizard adapter={adapter} onBack={onBack} onComplete={vi.fn()} />);

    expect(await screen.findByRole('heading', { name: 'Could not load setup' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Setup status is unavailable.');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('heading', { name: 'Check the essentials' })).toBeInTheDocument();
    expect(adapter.status).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(onBack).toHaveBeenCalledOnce();
  });

  it('keeps cancellation failures visible with retry and back available', async () => {
    const adapter = guidedAdapter({
      status: vi.fn(async () => ({ ...idle, phase: 'running' as const })),
      cancel: vi.fn(async () => { throw new Error('private cancellation failure'); }),
    });
    const onBack = vi.fn();
    render(<LocalSetupWizard adapter={adapter} onBack={onBack} onComplete={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Cancel safely' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Setup cancellation could not be confirmed.');
    expect(screen.getByRole('button', { name: 'Try cancellation again' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(onBack).toHaveBeenCalledOnce();
  });

  it('renders a failed recovery retry without hiding recovery controls', async () => {
    const failed = { ...idle, phase: 'failed' as const, error: 'Docker is unavailable.' };
    const adapter = guidedAdapter({
      status: vi.fn(async () => failed),
      retry: vi.fn(async () => { throw new Error('private retry failure'); }),
    });
    render(<LocalSetupWizard adapter={adapter} onBack={vi.fn()} onComplete={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Retry setup' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Local setup could not be started.');
    expect(screen.getByRole('button', { name: 'Retry setup' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back' })).toBeInTheDocument();
  });

  it('requires the dedicated recovery control before replacing an incompatible running stack', async () => {
    const incompatible: DesktopSetupSnapshot = {
      ...idle,
      phase: 'failed',
      state: {
        rootDir: '/redacted',
        steps: [{
          id: 'start-stack', title: 'Start stack', description: 'Launch services.', optional: false,
          status: 'failed', detail: 'The retained runtime is incompatible.',
          nextAction: 'Only this Desktop-managed stack is replaced; data and credentials are retained.',
          recoveryAction: 'replace-running-stack',
        }],
      },
      resumeAvailable: true,
      resume: {
        agents: [], reinitialize: false, github: { mode: 'relay' }, intake: { mode: 'routing_websocket' },
        whitelist: null, repository: null,
      },
    };
    const retry = vi.fn(async () => completed);
    render(<LocalSetupWizard adapter={guidedAdapter({ status: vi.fn(async () => incompatible), retry })} onBack={vi.fn()} onComplete={vi.fn()} />);

    const replace = await screen.findByRole('button', { name: 'Restart with aligned runtime' });
    expect(screen.getByText(/data and credentials are retained/i)).toBeInTheDocument();
    expect(retry).not.toHaveBeenCalled();
    fireEvent.click(replace);
    expect(await screen.findByRole('heading', { name: 'ProPR is ready' })).toBeInTheDocument();
    expect(retry).toHaveBeenCalledWith({
      sessionId: idle.sessionId,
      recoveryAction: 'replace-running-stack',
    });
  });

  it('offers credential review without replacing ordinary retry for a transient failure', async () => {
    const requiresReview: DesktopSetupSnapshot = {
      ...idle, phase: 'failed', error: 'The backend was temporarily unavailable.',
      resumeAvailable: true, reconfigurationRequired: true,
      resume: {
        agents: [], reinitialize: false,
        github: { mode: 'app', appId: '123', installationId: '456', reconfigurationRequired: true },
        intake: { mode: 'polling' }, whitelist: null, repository: null, reconfigurationStage: 'github',
      },
    };
    const retry = vi.fn(async () => completed);
    const adapter = guidedAdapter({ status: vi.fn(async () => requiresReview), retry });
    render(<LocalSetupWizard adapter={adapter} onBack={vi.fn()} onComplete={vi.fn()} />);

    expect(await screen.findByRole('button', { name: 'Review saved choices' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry setup' }));
    expect(await screen.findByRole('heading', { name: 'ProPR is ready' })).toBeInTheDocument();
    expect(retry).toHaveBeenCalledWith();
  });

  it('requires a supported choice when a legacy saved setup used Demo mode', async () => {
    const legacy: DesktopSetupSnapshot = {
      ...idle, phase: 'failed', error: 'Demo mode is no longer available in desktop setup.',
      resumeAvailable: true, reconfigurationRequired: true,
      resume: {
        agents: ['codex'], reinitialize: false, github: { mode: 'demo' }, intake: { mode: 'keep' },
        whitelist: null, repository: null, reconfigurationStage: 'github',
      },
    };
    const retry = vi.fn(async () => completed);
    render(<LocalSetupWizard adapter={guidedAdapter({ status: vi.fn(async () => legacy), retry })} onBack={vi.fn()} onComplete={vi.fn()} />);

    expect(await screen.findByLabelText('Selected configuration')).toHaveTextContent('Demo mode (unsupported)');
    fireEvent.click(screen.getByRole('button', { name: 'Review saved choices' }));
    expect(await screen.findByRole('heading', { name: 'Connect GitHub' })).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: /Demo/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: 'Keep existing configuration' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Continue/i }));
    expect(screen.getByRole('alert')).toHaveTextContent('Select ProPR Connect');

    fireEvent.click(screen.getByRole('radio', { name: 'ProPR Connect' }));
    for (const heading of ['GitHub event intake', 'Select coding agents', 'Ready to install']) {
      fireEvent.click(screen.getByRole('button', { name: /Continue/i }));
      await screen.findByRole('heading', { name: heading });
    }
    expect(screen.getByLabelText('Selected configuration')).toHaveTextContent('ProPR Connect');
    expect(screen.getByLabelText('Selected configuration')).toHaveTextContent('WebSocket');
    fireEvent.click(screen.getByRole('button', { name: /Install ProPR/i }));
    expect(retry).toHaveBeenCalledWith(expect.objectContaining({
      github: { mode: 'relay' }, intake: { mode: 'routing_websocket' },
    }));
  });

  it('shows and confirms corrected WebSocket intake for stale ProPR Connect recovery', async () => {
    const corrected: DesktopSetupSnapshot = {
      ...idle, phase: 'failed', error: 'ProPR Connect now requires WebSocket intake.',
      resumeAvailable: true, reconfigurationRequired: true,
      resume: {
        agents: ['codex'], reinitialize: false, github: { mode: 'relay' }, intake: { mode: 'routing_websocket' },
        whitelist: null, repository: null, reconfigurationStage: 'intake',
      },
    };
    const retry = vi.fn(async () => completed);
    render(<LocalSetupWizard adapter={guidedAdapter({ status: vi.fn(async () => corrected), retry })} onBack={vi.fn()} onComplete={vi.fn()} />);

    const saved = await screen.findByLabelText('Selected configuration');
    expect(saved).toHaveTextContent('ProPR Connect');
    expect(saved).toHaveTextContent('WebSocket');
    fireEvent.click(screen.getByRole('button', { name: 'Review saved choices' }));
    expect(await screen.findByText('ProPR Connect uses a persistent WebSocket connection for GitHub events.')).toBeInTheDocument();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    for (const heading of ['Select coding agents', 'Ready to install']) {
      fireEvent.click(screen.getByRole('button', { name: /Continue/i }));
      await screen.findByRole('heading', { name: heading });
    }
    fireEvent.click(screen.getByRole('button', { name: /Install ProPR/i }));
    expect(retry).toHaveBeenCalledWith(expect.objectContaining({ intake: { mode: 'routing_websocket' } }));
  });

  it.each(['failed', 'cancelled', 'interrupted'] as const)('lets a resumable %s setup revise ordinary saved choices', async phase => {
    const recoverable: DesktopSetupSnapshot = {
      ...idle, phase, error: 'ProPR Connect could not be configured.',
      resumeAvailable: true, reconfigurationRequired: false,
      resume: {
        agents: ['codex'], reinitialize: false, github: { mode: 'relay' },
        intake: { mode: 'routing_websocket' }, whitelist: ['octocat'], repository: null,
      },
    };
    const retry = vi.fn(async () => completed);
    const adapter = guidedAdapter({ status: vi.fn(async () => recoverable), retry });
    render(<LocalSetupWizard adapter={adapter} onBack={vi.fn()} onComplete={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Review saved choices' }));
    expect(await screen.findByRole('heading', { name: 'Connect GitHub' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'Keep existing configuration' }));
    for (const heading of ['GitHub event intake', 'Select coding agents', 'Ready to install']) {
      fireEvent.click(screen.getByRole('button', { name: /Continue/i }));
      await screen.findByRole('heading', { name: heading });
    }
    fireEvent.click(screen.getByRole('button', { name: /Install ProPR/i }));

    expect(await screen.findByRole('heading', { name: 'ProPR is ready' })).toBeInTheDocument();
    expect(retry).toHaveBeenCalledWith(expect.objectContaining({
      github: { mode: 'keep' }, intake: { mode: 'routing_websocket' },
    }));
  });

  it.each(['failed', 'cancelled'] as const)('returns a %s reconfigured retry to credential-free recovery', async phase => {
    const resume = {
      agents: ['codex'], reinitialize: false, github: { mode: 'keep' as const },
      intake: { mode: 'direct_webhook' as const, reconfigurationRequired: true as const },
      whitelist: null, repository: null, reconfigurationStage: 'intake' as const,
    };
    const requiresSecret: DesktopSetupSnapshot = {
      ...idle, phase: 'failed', error: 'Enter the webhook secret again.', resume,
      resumeAvailable: true, reconfigurationRequired: true,
    };
    const terminal: DesktopSetupSnapshot = {
      ...requiresSecret, phase, error: phase === 'cancelled' ? 'Setup was cancelled safely.' : 'Webhook setup failed.',
      reconfigurationRequired: false,
    };
    const retry = vi.fn()
      .mockResolvedValueOnce(terminal)
      .mockResolvedValueOnce(completed);
    const adapter = guidedAdapter({
      status: vi.fn(async () => requiresSecret), retry,
      acquireWebhookSecret: vi.fn(async () => ({ capability: 'webhook-secret-capability', label: 'Secret entered' as const })),
    });
    render(<LocalSetupWizard adapter={adapter} onBack={vi.fn()} onComplete={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Review saved choices' }));
    expect(await screen.findByRole('heading', { name: 'GitHub event intake' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Enter webhook secret securely' }));
    await screen.findByText('Secret entered');
    fireEvent.click(screen.getByRole('button', { name: /Continue/i }));
    await screen.findByRole('heading', { name: 'Select coding agents' });
    fireEvent.click(screen.getByRole('button', { name: /Continue/i }));
    await screen.findByRole('heading', { name: 'Ready to install' });
    fireEvent.click(screen.getByRole('button', { name: /Install ProPR/i }));

    expect(await screen.findByRole('heading', { name: 'Setup needs attention' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry setup' }));
    expect(await screen.findByRole('heading', { name: 'ProPR is ready' })).toBeInTheDocument();
    expect(retry).toHaveBeenNthCalledWith(1, expect.objectContaining({
      intake: { mode: 'direct_webhook', secretCapability: 'webhook-secret-capability' },
    }));
    expect(retry).toHaveBeenNthCalledWith(2);
  });
});
