import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AgentLoginModal from './AgentLoginModal';
import {
  cancelAgentLogin,
  getAgentLogin,
  sendAgentLoginInput,
  startAgentLogin,
} from '../../api/agentLoginApi';

vi.mock('../../api/agentLoginApi', () => ({
  startAgentLogin: vi.fn(),
  getAgentLogin: vi.fn(),
  sendAgentLoginInput: vi.fn(),
  cancelAgentLogin: vi.fn(),
}));

const agent = {
  id: 'codex-1',
  type: 'codex' as const,
  alias: 'codex',
  enabled: true,
  dockerImage: 'propr/agent:test',
  configPath: '/home/propr/.codex',
  supportedModels: ['gpt-test'],
};

const runningSession = {
  id: 'login-1',
  agentId: agent.id,
  agentType: agent.type,
  status: 'running' as const,
  output: 'Open https://example.test/device and enter the displayed code.\n',
  createdAt: '2026-07-29T00:00:00.000Z',
  updatedAt: '2026-07-29T00:00:00.000Z',
  expiresAt: '2026-07-29T00:10:00.000Z',
};

describe('AgentLoginModal', () => {
  beforeEach(() => {
    vi.mocked(startAgentLogin).mockReset().mockResolvedValue(runningSession);
    vi.mocked(getAgentLogin).mockReset().mockResolvedValue(runningSession);
    vi.mocked(sendAgentLoginInput).mockReset().mockResolvedValue(runningSession);
    vi.mocked(cancelAgentLogin).mockReset().mockResolvedValue({
      ...runningSession,
      status: 'cancelled',
    });
  });

  it('shows OAuth links and sends confirmation input to the active session', async () => {
    render(<AgentLoginModal agent={agent} onClose={vi.fn()} />);

    const link = await screen.findByRole('link', { name: 'https://example.test/device' });
    expect(link).toHaveAttribute('target', '_blank');
    await waitFor(() => {
      expect(screen.getByLabelText('Login response or confirmation code')).toHaveFocus();
    });

    fireEvent.change(screen.getByLabelText('Login response or confirmation code'), {
      target: { value: 'ABCD-1234' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      expect(sendAgentLoginInput).toHaveBeenCalledWith(agent.id, runningSession.id, 'ABCD-1234\n');
    });
  });

  it('cancels an active login when the dialog is closed', async () => {
    const onClose = vi.fn();
    render(<AgentLoginModal agent={agent} onClose={onClose} />);
    await screen.findByText('Waiting for login');

    fireEvent.click(screen.getByRole('button', { name: 'Cancel login' }));

    await waitFor(() => {
      expect(cancelAgentLogin).toHaveBeenCalledWith(agent.id, runningSession.id);
      expect(onClose).toHaveBeenCalledOnce();
    });
  });

  it('cancels and closes on Escape or a backdrop click', async () => {
    const onClose = vi.fn();
    const first = render(<AgentLoginModal agent={agent} onClose={onClose} />);
    await screen.findByText('Waiting for login');

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    first.unmount();

    onClose.mockClear();
    vi.mocked(cancelAgentLogin).mockClear();
    render(<AgentLoginModal agent={agent} onClose={onClose} />);
    await screen.findByText('Waiting for login');
    fireEvent.mouseDown(screen.getByTestId('agent-login-backdrop'));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });

  it('starts only one remote login session under React StrictMode', async () => {
    render(
      <React.StrictMode>
        <AgentLoginModal agent={agent} onClose={vi.fn()} />
      </React.StrictMode>,
    );

    await screen.findByText('Waiting for login');
    expect(startAgentLogin).toHaveBeenCalledOnce();
  });

  it('sends a bare Enter for a default terminal choice', async () => {
    render(<AgentLoginModal agent={agent} onClose={vi.fn()} />);
    await screen.findByText('Waiting for login');

    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      expect(sendAgentLoginInput).toHaveBeenCalledWith(agent.id, runningSession.id, '\n');
    });
  });

  it('sends terminal arrow keys for interactive provider menus', async () => {
    render(<AgentLoginModal agent={agent} onClose={vi.fn()} />);
    await screen.findByText('Waiting for login');

    fireEvent.click(screen.getByRole('button', { name: 'Down arrow' }));

    await waitFor(() => {
      expect(sendAgentLoginInput).toHaveBeenCalledWith(agent.id, runningSession.id, '\u001b[B');
    });
  });

  it('cancels a session that finishes starting after the dialog unmounts', async () => {
    let resolveStart!: (session: typeof runningSession) => void;
    vi.mocked(startAgentLogin).mockReturnValue(new Promise(resolve => {
      resolveStart = resolve;
    }));
    const { unmount } = render(<AgentLoginModal agent={agent} onClose={vi.fn()} />);

    unmount();
    resolveStart(runningSession);

    await waitFor(() => {
      expect(cancelAgentLogin).toHaveBeenCalledWith(agent.id, runningSession.id);
    });
  });

  it('cancels a session that finishes starting after the user dismisses the dialog', async () => {
    let resolveStart!: (session: typeof runningSession) => void;
    vi.mocked(startAgentLogin).mockReturnValue(new Promise(resolve => {
      resolveStart = resolve;
    }));
    const Harness = () => {
      const [open, setOpen] = React.useState(true);
      return open ? <AgentLoginModal agent={agent} onClose={() => setOpen(false)} /> : null;
    };
    render(<Harness />);

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    resolveStart(runningSession);

    await waitFor(() => {
      expect(cancelAgentLogin).toHaveBeenCalledWith(agent.id, runningSession.id);
    });
  });

  it('cancels the old session and starts a new one when the agent changes in place', async () => {
    const nextAgent = {
      ...agent,
      id: 'codex-2',
      alias: 'codex-second',
      configPath: '/home/propr/.codex-second',
    };
    const nextSession = {
      ...runningSession,
      id: 'login-2',
      agentId: nextAgent.id,
    };
    vi.mocked(startAgentLogin)
      .mockResolvedValueOnce(runningSession)
      .mockResolvedValueOnce(nextSession);

    const { rerender } = render(<AgentLoginModal agent={agent} onClose={vi.fn()} />);
    await screen.findByText('Waiting for login');
    rerender(<AgentLoginModal agent={nextAgent} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(startAgentLogin).toHaveBeenNthCalledWith(2, nextAgent.id);
      expect(cancelAgentLogin).toHaveBeenCalledWith(agent.id, runningSession.id);
    });
    expect(screen.getByRole('heading', { name: 'Log in to codex-second' })).toBeInTheDocument();
  });
});
