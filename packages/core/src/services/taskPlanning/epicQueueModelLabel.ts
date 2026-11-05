/** Resolves the GitHub model label that a queued issue's agent and model selection dispatches with. */
export async function queuedModelLabel(selection: { agent_alias: string; model_name: string }): Promise<string | null> {
  const { AgentRegistry } = await import('../../agents/AgentRegistry.js');
  const { MODEL_INFO_MAP } = await import('../../config/modelDefinitions.js');
  const { agentSupportsSavedModel, buildAgentModelLlmLabel, buildDynamicLlmLabel, currentAntigravityModel, currentOpenCodeModel } = await import('@propr/shared');
  const { toProprOpenCodeModelId } = await import('../../agents/impl/openCodeUtils.js');
  const registry = AgentRegistry.getInstance();
  await registry.ensureInitialized();
  // A queued retired Antigravity or OpenCode model dispatches with the model it now runs on.
  const modelName = currentOpenCodeModel(currentAntigravityModel(selection.model_name));
  const modelInfo = MODEL_INFO_MAP[modelName];
  const agent = registry.getAgentByAlias(selection.agent_alias) ?? registry.getAllAgents().find(candidate =>
    candidate.config.supportedModels.some(model => model.toLowerCase() === modelName.toLowerCase()
      || (candidate.config.type === 'opencode' && model.toLowerCase() === toProprOpenCodeModelId(modelName).toLowerCase()))
    || agentSupportsSavedModel(candidate.config, modelName));
  if (!agent) return modelInfo?.githubLabel ?? null;
  if (modelInfo?.githubLabel) return buildAgentModelLlmLabel(agent.config.type, agent.config.alias, modelInfo);
  const model = agent.config.type === 'opencode' ? toProprOpenCodeModelId(modelName) : modelName;
  return buildDynamicLlmLabel(agent.config.alias, model);
}
