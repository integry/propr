import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getManagedAgentConfigPath } from '@propr/shared';
import AgentConfigModal from './AgentConfigModal';
import AgentLoginModal from './AgentLoginModal';
import { startAgentLogin } from '../../api/agentLoginApi';
import { buildPiModelId, piApiKeyEnvNames, piLoginProviderChoices } from './piAgentFieldsUtils';
import { AGENT_DEFAULTS } from '../../config/modelDefinitions';

vi.mock('../../api/agentVersionApi', () => ({
  getAgentVersions: vi.fn().mockResolvedValue({
    agentType: 'pi', defaultVersion: '1.6.1', availableTags: [], recentVersions: [],
  }),
}));

vi.mock('../../api/proprApi', () => ({
  getOpenCodeModels: vi.fn().mockResolvedValue({ models: [] }),
}));

vi.mock('../../api/agentLoginApi', () => ({
  startAgentLogin: vi.fn(),
  getAgentLogin: vi.fn(),
  sendAgentLoginInput: vi.fn(),
  cancelAgentLogin: vi.fn(),
}));

const piAgent = {
  id: 'pi-1', type: 'pi' as const, alias: 'pi', enabled: true, dockerImage: 'propr/agent:test',
  configPath: getManagedAgentConfigPath('pi-1', 'pi'),
  supportedModels: ['pi-openrouter/mistralai/devstral-2512', 'pi-anthropic/claude-sonnet-5-5'],
  defaultModel: 'pi-openrouter/mistralai/devstral-2512',
};

describe('Pi agent settings helpers', () => {
  it('builds Pi model ids and lists key variables for the selected providers', () => {
    expect(buildPiModelId('OpenRouter', ' qwen/qwen3-coder ')).toBe('pi-openrouter/qwen/qwen3-coder');
    expect(buildPiModelId('anthropic', '')).toBeUndefined();
    expect(buildPiModelId('bad provider', 'x')).toBeUndefined();
    expect(piApiKeyEnvNames(piAgent.supportedModels, piAgent.defaultModel, { HF_TOKEN: 'x', OTHER: 'y' }))
      .toEqual(['OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY', 'HF_TOKEN']);
    expect(piLoginProviderChoices(piAgent).slice(0, 3)).toEqual(['openrouter', 'anthropic', 'openai-codex']);
  });
});

describe('AgentConfigModal for Pi', () => {
  it('offers login, existing config and API-key credentials, and saves API keys as env vars', () => {
    const onSave = vi.fn();
    render(<AgentConfigModal agent={null} existingAliases={[]} onClose={vi.fn()} onSave={onSave} />);

    fireEvent.click(screen.getByRole('button', { name: 'pi' }));
    expect(screen.getByLabelText('ID / Alias')).toHaveValue(AGENT_DEFAULTS.pi.defaultAlias);
    expect(screen.getByRole('button', { name: 'Log in to a new account' })).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(screen.getByRole('button', { name: 'Use existing config' }));
    expect(screen.getByLabelText('Config path')).toHaveValue('~/.pi/agent');

    fireEvent.click(screen.getByRole('button', { name: 'Use API keys' }));
    expect(screen.queryByLabelText('Config path')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add Agent' }));
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByText('Enter an API key for at least one provider')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/^OPENROUTER_API_KEY/), { target: { value: ' sk-or-test ' } });
    fireEvent.change(screen.getByLabelText('Pi model id'), { target: { value: 'qwen/qwen3-coder' } });
    fireEvent.change(screen.getByLabelText('Pi model provider'), { target: { value: 'openrouter' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add Agent' }));

    expect(onSave).toHaveBeenCalledTimes(1);
    const [saved, options] = onSave.mock.calls[0];
    expect(saved.type).toBe('pi');
    expect(saved.envVars).toEqual({ OPENROUTER_API_KEY: 'sk-or-test' });
    expect(saved.configPath).toBe(getManagedAgentConfigPath(saved.id, 'pi'));
    expect(saved.supportedModels).toContain('pi-openrouter/qwen/qwen3-coder');
    expect(options).toEqual({ loginAfterSave: false });
  });

  it('drops the API-key option when switching to an agent without it', () => {
    render(<AgentConfigModal agent={null} existingAliases={[]} onClose={vi.fn()} onSave={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'pi' }));
    fireEvent.click(screen.getByRole('button', { name: 'Use API keys' }));
    fireEvent.click(screen.getByRole('button', { name: 'codex' }));
    expect(screen.queryByRole('button', { name: 'Use API keys' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Log in to a new account' })).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('AgentLoginModal for Pi', () => {
  beforeEach(() => {
    vi.mocked(startAgentLogin).mockReset().mockResolvedValue({
      id: 'login-1', agentId: piAgent.id, agentType: 'pi', provider: 'anthropic', apiKey: false, status: 'running',
      output: 'Open https://example.test/oauth to sign in\n',
      createdAt: '2026-11-27T00:00:00.000Z', updatedAt: '2026-11-27T00:00:00.000Z', expiresAt: '2026-11-27T00:10:00.000Z',
    });
  });

  it('chooses the provider and method before starting the login container', async () => {
    render(<AgentLoginModal agent={piAgent} onClose={vi.fn()} />);
    expect(startAgentLogin).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Provider')).toHaveValue('openrouter');

    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'anthropic' } });
    fireEvent.click(screen.getByRole('button', { name: /Sign in with an account/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Start login' }));

    await waitFor(() => expect(startAgentLogin).toHaveBeenCalledWith(piAgent.id, { provider: 'anthropic' }));
    expect(await screen.findByRole('link', { name: 'https://example.test/oauth' })).toBeInTheDocument();
    expect(screen.getByText(/^anthropic · Credentials are saved to/)).toBeInTheDocument();
  });

  it('requests an API-key login for providers without an account sign-in', async () => {
    render(<AgentLoginModal agent={piAgent} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'google' } });
    expect(screen.getByRole('button', { name: /Sign in with an account/ })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Start login' }));
    await waitFor(() => expect(startAgentLogin).toHaveBeenCalledWith(piAgent.id, { provider: 'google', apiKey: true }));
  });
});
