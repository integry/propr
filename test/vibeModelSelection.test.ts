import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentRegistry } from '../packages/core/src/agents/AgentRegistry.js';
import { resolveLlmLabel } from '../packages/core/src/config/modelLabelResolution.js';
import { findMatchingModel, getModelShortName, getAgentTypeFromModel } from '../packages/core/src/config/modelAliases.js';
import { AGENT_DEFAULTS } from '@propr/shared';
import { closeConnection } from '../packages/core/src/db/connection.js';
import type { AgentConfig } from '../packages/core/src/config/configManagerAgents.js';

after(closeConnection);

test('GLM labels and aliases resolve to the configured Vibe account', async (t) => {
    const config: AgentConfig = {
        id: 'vibe-account', alias: 'mistral-work', type: 'vibe', enabled: true,
        dockerImage: 'propr/agent:latest', configPath: '/srv/vibe',
        supportedModels: AGENT_DEFAULTS.vibe.defaultModels, defaultModel: 'mistral-medium-3.5',
    };
    const registry = AgentRegistry.getInstance();
    t.mock.method(registry, 'ensureInitialized', async () => {});
    t.mock.method(registry, 'getAllAgents', () => [{ config }]);
    for (const minor of ['3', '2']) {
        const id = `zai-glm-5-${minor}`;
        assert.equal(getAgentTypeFromModel(id), 'vibe');
        assert.equal(getModelShortName(id), `GLM 5.${minor}`);
        assert.equal(findMatchingModel(`glm5${minor}`, config), id);
        for (const label of [`vibe-glm5${minor}`, `mistral-work-glm5${minor}`]) {
            const selected = await resolveLlmLabel(label);
            assert.equal(selected.agentAlias, config.alias);
            assert.equal(selected.model, id);
        }
    }
    assert.equal((await resolveLlmLabel('vibe-mistral')).model, 'mistral-medium-3.5');
});
