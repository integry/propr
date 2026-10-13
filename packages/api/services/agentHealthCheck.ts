import type { Agent, AgentConfig } from '@propr/core';
import { computeContentHash, generateAgentBundleImageTag, getAgentCliVersionMatrix, redactSecrets } from '@propr/core';
import { AGENT_MODELS } from '@propr/shared';

// Prefer inexpensive, quick models already offered by this configuration.
// Codex login accounts may not offer API-only nano models, so prefer Luna.
const PROBE_MODELS: Record<AgentConfig['type'], string[]> = {
  claude: ['claude-haiku-4-5-20251001', ...AGENT_MODELS.claude.map(model => model.id).filter(id => id.includes('sonnet'))],
  codex: ['gpt-6-luna', 'gpt-5.6-luna', 'gpt-5.3-codex-spark', 'gpt-5.4-mini', 'gpt-5.4-nano', 'gpt-5-nano', 'gpt-5-mini', 'gpt-6.1-sol', 'gpt-6-sol', 'gpt-5.6-sol'],
  antigravity: AGENT_MODELS.antigravity.map(model => model.id).filter(id => id.includes('flash')),
  opencode: ['opencode-ling-3.0-flash-fin-free', 'opencode-nemotron-3.5-lightning-free', 'opencode-big-pickle', ...AGENT_MODELS.opencode.map(model => model.id)],
  vibe: ['mistral-medium-3.5'],
};

export function agentHealthModel(config: AgentConfig): string | undefined {
  return PROBE_MODELS[config.type].find(model => config.supportedModels.includes(model))
    ?? (config.defaultModel && config.supportedModels.includes(config.defaultModel) ? config.defaultModel : undefined)
    ?? config.supportedModels[0];
}

export interface AgentHealthResult {
  agentId: string;
  status: 'ready' | 'error' | 'disabled' | 'preparing';
  model?: string;
  error?: string;
  errorCode?: 'auth_required' | 'rate_limit' | 'unknown' | 'preparation_failed';
}

function healthErrorCode(error: unknown): NonNullable<AgentHealthResult['errorCode']> {
  const details = error as { code?: unknown; status?: unknown; statusCode?: unknown; message?: unknown } | undefined;
  const text = [details?.code, details?.status, details?.statusCode, details?.message, error].join(' ');
  // Quota failures can also suggest signing in; rate limits take precedence.
  if (/\b429\b|rate[\s_-]*limit|resource[\s_-]*exhausted|too many requests|quota|usage limit/i.test(text)) return 'rate_limit';
  if (/\b401\b|unauthenticated|unauthorized|authentication|not logged in|log[ -]?in|sign[ -]?in|session.{0,30}expired|expired.{0,30}(?:session|token|credentials)/i.test(text)) return 'auth_required';
  return 'unknown';
}

export function createAgentHealthCheck(dependencies: {
  loadAgents: () => Promise<AgentConfig[]>;
  createAgent: (config: AgentConfig) => Pick<Agent, 'analyze'>;
  imageExists?: (image: string) => Promise<boolean>;
  prepareImage?: (image: string) => Promise<void>;
}) {
  // Share worker requests across providers using the same exact image.
  const preparations = new Map<string, { failed: boolean; pending: boolean }>();
  const inFlight = new Map<string, Promise<AgentHealthResult>>();

  async function loadEffectiveAgents(): Promise<AgentConfig[]> {
    const agents = await dependencies.loadAgents();
    // Match registry resolution: saved tags can outlive bundle/version changes,
    // and even a sibling provider's CLI version changes the shared image.
    const image = generateAgentBundleImageTag(getAgentCliVersionMatrix(agents), computeContentHash());
    return agents.map(agent => ({ ...agent, dockerImage: image }));
  }

  function pruneUnusedPreparations(agents: AgentConfig[]): void {
    for (const [image, state] of preparations) {
      if (!state.pending && !agents.some(agent => agent.enabled && agent.dockerImage === image)) preparations.delete(image);
    }
  }

  return async function check(agentId: string, fresh = false): Promise<AgentHealthResult | undefined> {
    const agents = await loadEffectiveAgents();
    pruneUnusedPreparations(agents);
    const config = agents.find(agent => agent.id === agentId);
    if (!config) return undefined;
    if (!config.enabled) return { agentId, status: 'disabled' };
    const key = JSON.stringify(config);
    if (dependencies.imageExists && dependencies.prepareImage) {
      const image = config.dockerImage;
      try {
        const exists = await dependencies.imageExists(image);
        const current = (await loadEffectiveAgents()).find(agent => agent.id === agentId);
        if (JSON.stringify(current) !== key) return check(agentId, fresh);
        if (!exists) {
          let preparation = preparations.get(image);
          if (fresh && preparation?.failed) {
            preparations.delete(image);
            preparation = undefined;
          }
          if (!preparation) {
            preparation = { failed: false, pending: true };
            preparations.set(image, preparation);
            const state = preparation;
            void dependencies.prepareImage(image).then(async () => {
              // Completion is evidence for this target only. A later check
              // resolves a newer bundle independently if configuration changed.
              state.failed = !await dependencies.imageExists!(image);
            }).catch(() => { state.failed = true; }).finally(() => { state.pending = false; });
          }
          return preparation.failed
            ? { agentId, status: 'error', errorCode: 'preparation_failed',
                error: 'Agent image preparation failed. Check the worker status and available disk space, then check again.' }
            : { agentId, status: 'preparing' };
        }
        // A verified image can recover even after an earlier worker failure.
        preparations.delete(image);
      } catch {
        return { agentId, status: 'error', errorCode: 'preparation_failed',
          error: 'Could not verify the agent image. Check that Docker and the worker are running, then check again.' };
      }
    }
    const existing = inFlight.get(key);
    if (existing) {
      if (!fresh) {
        const result = await existing;
        const current = (await loadEffectiveAgents()).find(agent => agent.id === agentId);
        return JSON.stringify(current) === key ? result : check(agentId);
      }
      // Login changes credentials without changing config. A refresh must wait
      // for the old probe, then reload config and create a new agent instance.
      await existing;
      return check(agentId);
    }
    const probe = async (): Promise<AgentHealthResult> => {
      const model = agentHealthModel(config);
      if (!model) return { agentId, status: 'error', errorCode: 'unknown', error: 'No models configured. Edit this agent to add a model.' };
      try {
        const result = await dependencies.createAgent(config).analyze('Reply with only OK. Do not use tools.', {
          model,
          timeoutMs: 30_000,
          executionType: 'agent-health-check',
          suppressLlmLog: true,
          skipUsageTracking: true,
        });
        if (!result.success || !result.response?.trim()) {
          return { agentId, model, status: 'error', errorCode: healthErrorCode(result.error), error: redactSecrets(result.error || 'Agent returned no response.').slice(0, 2000) };
        }
        return { agentId, model, status: 'ready' };
      } catch (error) {
        return { agentId, model, status: 'error', errorCode: healthErrorCode(error), error: redactSecrets(error instanceof Error ? error.message : 'Agent check failed.').slice(0, 2000) };
      }
    };
    const promise = probe().finally(() => {
      if (inFlight.get(key) === promise) inFlight.delete(key);
    });
    inFlight.set(key, promise);
    const result = await promise;
    const current = (await loadEffectiveAgents()).find(agent => agent.id === agentId);
    return JSON.stringify(current) === key ? result : check(agentId);
  };
}
