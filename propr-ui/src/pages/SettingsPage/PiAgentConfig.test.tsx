import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getManagedAgentConfigPath } from '@propr/shared';
import AgentConfigModal from './AgentConfigModal';
import AgentLoginModal from './AgentLoginModal';
import { startAgentLogin } from '../../api/agentLoginApi';
import { buildPiModelId, describePiModel, piApiKeyEnvNames, piLoginProviderChoices } from './piAgentFieldsUtils';
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

  it('describes Pi models by display name and provider label, never the raw id', () => {
    expect(describePiModel('pi-openrouter/qwen/qwen3-coder')).toBe('Qwen3 Coder via OpenRouter');
    expect(describePiModel('pi-anthropic/claude-sonnet-5-5')).toBe('Claude Sonnet 5.5 via Anthropic');
    expect(describePiModel('pi-some-new-host/foo-model-2')).toBe('Foo Model 2 via Some New Host');
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
    expect(screen.getByText('Adds Qwen3 Coder via OpenRouter.')).toBeInTheDocument();
    expect(screen.queryByText(/qwen\/qwen3-coder/)).not.toBeInTheDocument();
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

describe('AgentConfigModal type changes drop hidden provider keys', () => {
  it('a Pi agent switched to Claude does not keep its provider API keys', () => {
    const onSave = vi.fn();
    const agent = { ...piAgent, envVars: { ANTHROPIC_API_KEY: 'sk-ant-test', OPENROUTER_API_KEY: 'sk-or-test', HTTPS_PROXY: 'http://proxy.test' } };
    render(<AgentConfigModal agent={agent} existingAliases={[]} onClose={vi.fn()} onSave={onSave} />);
    expect(screen.getByLabelText(/^ANTHROPIC_API_KEY/)).toHaveValue('sk-ant-test');

    fireEvent.click(screen.getByRole('button', { name: 'claude' }));
    expect(screen.queryByLabelText(/^ANTHROPIC_API_KEY/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    expect(onSave).toHaveBeenCalledTimes(1);
    const [saved] = onSave.mock.calls[0];
    expect(saved.type).toBe('claude');
    // Only the variable that is not a Pi provider key stays.
    expect(saved.envVars).toEqual({ HTTPS_PROXY: 'http://proxy.test' });
  });

  it('a Vibe agent switched to Pi does not keep its hidden Mistral key, and back again', () => {
    const onSave = vi.fn();
    const vibeAgent = {
      id: 'vibe-1', type: 'vibe' as const, alias: 'vibe', enabled: true, dockerImage: 'propr/agent:test', configPath: '~/.vibe',
      supportedModels: AGENT_DEFAULTS.vibe.defaultModels, defaultModel: AGENT_DEFAULTS.vibe.defaultModels[0],
      envVars: { MISTRAL_API_KEY: 'mistral-test' },
    };
    render(<AgentConfigModal agent={vibeAgent} existingAliases={[]} onClose={vi.fn()} onSave={onSave} />);
    expect(screen.getByLabelText('Mistral API Key')).toHaveValue('mistral-test');

    fireEvent.click(screen.getByRole('button', { name: 'pi' }));
    expect(screen.queryByLabelText(/MISTRAL_API_KEY/)).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/^OPENROUTER_API_KEY/), { target: { value: 'sk-or-test' } });

    // Back to Vibe: the Pi key goes, and the Mistral key field starts empty.
    fireEvent.click(screen.getByRole('button', { name: 'vibe' }));
    expect(screen.getByLabelText('Mistral API Key')).toHaveValue('');
    fireEvent.click(screen.getByRole('button', { name: 'pi' }));
    expect(screen.getByLabelText(/^OPENROUTER_API_KEY/)).toHaveValue('');
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    const [saved] = onSave.mock.calls[0];
    expect(saved.type).toBe('pi');
    expect(saved.envVars).toBeUndefined();
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

  it('recomputes the method whenever the resolved provider changes, including typed custom ids', async () => {
    render(<AgentLoginModal agent={piAgent} onClose={vi.fn()} />);
    const accountButton = () => screen.getByRole('button', { name: /Sign in with an account/ });
    const apiKeyButton = () => screen.getByRole('button', { name: /Save an API key/ });

    // A key-only provider forces the API-key method.
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'google' } });
    expect(apiKeyButton()).toHaveAttribute('aria-pressed', 'true');

    // "Other provider…" with a typed id that has an account sign-in: back to the account method.
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: '__other__' } });
    fireEvent.change(screen.getByLabelText('Pi provider id'), { target: { value: 'Anthropic' } });
    expect(accountButton()).toBeEnabled();
    expect(accountButton()).toHaveAttribute('aria-pressed', 'true');

    // A typed key-only id switches it to the API key, and a typed unknown id resets to the account default.
    fireEvent.change(screen.getByLabelText('Pi provider id'), { target: { value: 'google' } });
    expect(apiKeyButton()).toHaveAttribute('aria-pressed', 'true');
    expect(accountButton()).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Pi provider id'), { target: { value: 'fireworks' } });
    expect(accountButton()).toHaveAttribute('aria-pressed', 'true');

    // A choice made for one provider applies to it only.
    fireEvent.click(apiKeyButton());
    fireEvent.change(screen.getByLabelText('Pi provider id'), { target: { value: 'anthropic' } });
    expect(accountButton()).toHaveAttribute('aria-pressed', 'true');
    fireEvent.change(screen.getByLabelText('Pi provider id'), { target: { value: 'fireworks' } });
    expect(apiKeyButton()).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Start login' }));
    await waitFor(() => expect(startAgentLogin).toHaveBeenCalledWith(piAgent.id, { provider: 'fireworks', apiKey: true }));
  });

  it('requests an API-key login for providers without an account sign-in', async () => {
    render(<AgentLoginModal agent={piAgent} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'google' } });
    expect(screen.getByRole('button', { name: /Sign in with an account/ })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Start login' }));
    await waitFor(() => expect(startAgentLogin).toHaveBeenCalledWith(piAgent.id, { provider: 'google', apiKey: true }));
  });
});
