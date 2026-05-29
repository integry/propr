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
});
