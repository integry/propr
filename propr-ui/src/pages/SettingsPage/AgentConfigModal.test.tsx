import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import AgentConfigModal from './AgentConfigModal';
import { AGENT_DEFAULTS, AGENT_MODELS } from '../../config/modelDefinitions';

vi.mock('../../api/agentVersionApi', () => ({
  getAgentVersions: vi.fn().mockResolvedValue({
    agentType: 'opencode',
    defaultVersion: '1.15.12',
    availableTags: [],
    recentVersions: [],
  }),
}));

vi.mock('../../api/proprApi', () => ({
  getOpenCodeModels: vi.fn().mockResolvedValue({
    models: ['opencode-openai/gpt-5.5', 'opencode-openai/gpt-5.5-fast'],
  }),
}));

describe('AgentConfigModal', () => {
  it('shows OpenCode and populates OpenCode defaults from shared agent definitions', () => {
    const onSave = vi.fn();

    render(
      <AgentConfigModal
        agent={null}
        existingAliases={[]}
        onClose={vi.fn()}
        onSave={onSave}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'OpenCode' }));

    expect(screen.getByLabelText('ID / Alias')).toHaveValue(AGENT_DEFAULTS.opencode.defaultAlias);
    expect(screen.getByLabelText('Config Path')).toHaveValue(AGENT_DEFAULTS.opencode.configPath);
    expect(screen.getByText(AGENT_DEFAULTS.opencode.defaultCliVersion)).toBeInTheDocument();

    const defaultOpenCodeModel = AGENT_MODELS.opencode[0];
    expect(screen.getByText(defaultOpenCodeModel.name)).toBeInTheDocument();
    expect(screen.getByText(defaultOpenCodeModel.id)).toBeInTheDocument();
    expect(screen.getByText(defaultOpenCodeModel.githubLabel)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Add Agent' }));

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      type: 'opencode',
      alias: AGENT_DEFAULTS.opencode.defaultAlias,
      dockerImage: AGENT_DEFAULTS.opencode.dockerImage,
      configPath: AGENT_DEFAULTS.opencode.configPath,
      supportedModels: AGENT_DEFAULTS.opencode.defaultModels,
      defaultModel: AGENT_DEFAULTS.opencode.defaultModels[0],
      cliVersionType: 'default',
      cliVersionResolved: AGENT_DEFAULTS.opencode.defaultCliVersion,
    }));
  });

  it('adds discovered OpenCode provider models to the supported model selector', async () => {
    render(
      <AgentConfigModal
        agent={null}
        existingAliases={[]}
        onClose={vi.fn()}
        onSave={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'OpenCode' }));

    expect(await screen.findByText('Opencode OpenAI GPT 5.5')).toBeInTheDocument();
    expect(screen.getByText('opencode-openai/gpt-5.5')).toBeInTheDocument();
    expect(screen.getByText('llm-opencode:opencode-openai/gpt-5.5')).toBeInTheDocument();
  });

  it('shows OpenCode models already saved on an agent even when they are not static defaults', async () => {
    render(
      <AgentConfigModal
        agent={{
          id: 'agent-opencode-openai',
          type: 'opencode',
          alias: 'opencode',
          enabled: true,
          dockerImage: AGENT_DEFAULTS.opencode.dockerImage,
          configPath: AGENT_DEFAULTS.opencode.configPath,
          supportedModels: ['opencode-openai/gpt-5.5'],
          defaultModel: 'opencode-openai/gpt-5.5',
        }}
        existingAliases={['opencode']}
        onClose={vi.fn()}
        onSave={vi.fn()}
      />
    );

    expect(await screen.findByText('Opencode OpenAI GPT 5.5')).toBeInTheDocument();
    expect(screen.getByText('opencode-openai/gpt-5.5')).toBeInTheDocument();
  });
});
