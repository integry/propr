import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { getManagedAgentConfigPath } from '@propr/shared';
import AgentConfigModal from './AgentConfigModal';

const credentialApi = vi.hoisted(() => ({
  getAgentCredentials: vi.fn(),
  clearAgentCredential: vi.fn(),
  setAgentCredential: vi.fn(),
}));

vi.mock('../../api/agentCredentialApi', () => credentialApi);
vi.mock('../../api/agentVersionApi', () => ({
  getAgentVersions: vi.fn().mockResolvedValue({ agentType: 'claude', defaultVersion: '2.1.330', availableTags: [], recentVersions: [] }),
}));
vi.mock('../../api/proprApi', () => ({ getOpenCodeModels: vi.fn().mockResolvedValue({ models: [] }) }));

describe('pasted agent credentials', () => {
  beforeEach(() => {
    credentialApi.getAgentCredentials.mockReset();
    credentialApi.clearAgentCredential.mockReset();
  });

  it('adds a Claude agent with a pasted setup-token in its managed store, without a login', () => {
    const onSave = vi.fn();
    render(<AgentConfigModal agent={null} existingAliases={[]} onClose={vi.fn()} onSave={onSave} />);

    fireEvent.click(screen.getByRole('button', { name: 'Paste a key or token' }));
    expect(screen.getByRole('button', { name: 'Add Agent' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add Agent' }));
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByText('Paste a key or token, or choose another credential setup')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Claude subscription token (claude setup-token)' }));
    const input = screen.getByLabelText('Claude subscription token (claude setup-token)');
    expect(input).toHaveAttribute('type', 'password');
    fireEvent.change(input, { target: { value: 'sk-ant-oat01-example' } });
    expect(screen.getByRole('link', { name: /Claude Code authentication/ })).toHaveAttribute('href', 'https://code.claude.com/docs/en/iam');
    fireEvent.click(screen.getByRole('button', { name: 'Add Agent' }));

    const [saved, options] = onSave.mock.calls[0];
    expect(saved.configPath).toBe(getManagedAgentConfigPath(saved.id, 'claude'));
    expect(options).toEqual({ loginAfterSave: false, credential: { kind: 'claude-oauth-token', value: 'sk-ant-oat01-example' } });
  });

  it('shows only set + last four characters for a saved Codex agent and can remove the credential', async () => {
    credentialApi.getAgentCredentials.mockResolvedValue({
      agentId: 'codex-1', loginPresent: false,
      credentials: [{ kind: 'openai-api-key', set: true, last4: 'WXYZ' }, { kind: 'codex-auth-json', set: false }],
    });
    credentialApi.clearAgentCredential.mockResolvedValue({
      agentId: 'codex-1', loginPresent: false,
      credentials: [{ kind: 'openai-api-key', set: false }, { kind: 'codex-auth-json', set: false }],
    });
    const onSave = vi.fn();
    render(<AgentConfigModal
      agent={{ id: 'codex-1', type: 'codex', alias: 'codex', enabled: true, dockerImage: 'propr/agent:latest',
        configPath: getManagedAgentConfigPath('codex-1', 'codex'), supportedModels: ['gpt-6-luna'] }}
      existingAliases={[]} onClose={vi.fn()} onSave={onSave}
    />);

    expect(await screen.findByText(/OpenAI API key: set/)).toBeInTheDocument();
    expect(screen.getByText('WXYZ')).toBeInTheDocument();
    expect(screen.getByLabelText('OpenAI API key')).toHaveValue('');
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(credentialApi.clearAgentCredential).toHaveBeenCalledWith('codex-1', 'openai-api-key'));
    expect(await screen.findByText('OpenAI API key: not set')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Codex auth.json (ChatGPT login)' }));
    fireEvent.change(screen.getByLabelText('Codex auth.json (ChatGPT login)'), { target: { value: '{"tokens":{}}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    expect(onSave.mock.calls[0][1]).toEqual({ loginAfterSave: false, credential: { kind: 'codex-auth-json', value: '{"tokens":{}}' } });
  });
});
