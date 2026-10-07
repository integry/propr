import { useEffect, useState } from 'react';
import type { InstanceCatalogResponse } from '@propr/shared';
import { getInstanceCatalog } from '../../api/proprApi';

/**
 * The model the server falls back to when the planner sends no explicit model, mirroring
 * `resolveConfiguredModel`: the planner override setting first, then the default agent
 * (configured alias, else the agent named `default`) with its default model.
 */
export function resolveInstanceDefaultModel(catalog: Pick<InstanceCatalogResponse, 'agents' | 'defaultAgentAlias' | 'plannerGenerationModel'>): string | null {
  if (catalog.plannerGenerationModel?.trim()) return catalog.plannerGenerationModel.trim();
  const agent = catalog.agents.find(candidate => candidate.alias === catalog.defaultAgentAlias)
    ?? catalog.agents.find(candidate => candidate.alias === 'default');
  const model = agent?.defaultModel?.trim();
  return agent && model ? `${agent.alias}:${model}` : null;
}

/** Loads the instance-wide planner default model (`agent:model`, or a bare label); null until known. */
export function useInstanceDefaultModel(): string | null {
  const [model, setModel] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    getInstanceCatalog()
      .then(catalog => { if (!cancelled) setModel(resolveInstanceDefaultModel(catalog)); })
      .catch(err => console.error('Failed to load the default model:', err));
    return () => { cancelled = true; };
  }, []);
  return model;
}
