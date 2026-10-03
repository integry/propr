import type { Agent, AgentConfig } from '@propr/core';
import { redactSecrets } from '@propr/core';
import { AGENT_MODELS } from '@propr/shared';

// Prefer inexpensive, quick models already offered by this configuration.
// Codex login accounts may not offer API-only nano models, so prefer Luna.
const PROBE_MODELS: Record<AgentConfig['type'], string[]> = {
  claude: ['claude-haiku-4-5-20251001', ...AGENT_MODELS.claude.map(model => model.id).filter(id => id.includes('sonnet'))],
  codex: ['gpt-6-luna', 'gpt-5.6-luna', 'gpt-5.3-codex-spark', 'gpt-5.4-mini', 'gpt-5.4-nano', 'gpt-5-nano', 'gpt-5-mini', 'gpt-6.1-sol', 'gpt-6-sol', 'gpt-5.6-sol'],
  antigravity: [
    ...AGENT_MODELS.antigravity.map(model => model.id).filter(id => id.includes('flash') && id.endsWith('-low')),
    ...AGENT_MODELS.antigravity.map(model => model.id).filter(id => id.includes('flash') && !id.endsWith('-low')),
  ],
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
  status: 'ready' | 'error' | 'disabled';
  model?: string;
  error?: string;
  errorCode?: 'auth_required' | 'rate_limit' | 'unknown';
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
}) {
  const inFlight = new Map<string, Promise<AgentHealthResult>>();
  return async function check(agentId: string, fresh = false): Promise<AgentHealthResult | undefined> {
    const config = (await dependencies.loadAgents()).find(agent => agent.id === agentId);
    if (!config) return undefined;
    if (!config.enabled) return { agentId, status: 'disabled' };
    const key = JSON.stringify(config);
    const existing = inFlight.get(key);
    if (existing) {
      if (!fresh) return existing;
      // Login changes credentials without changing config. A refresh must wait
      // for the old probe, then reload config and create a new agent instance.
      await existing;
      return check(agentId, fresh);
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
    return promise;
  };
}
