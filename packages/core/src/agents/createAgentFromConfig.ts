import type { Agent, AgentConfig } from './types.js';
import { AntigravityAgent } from './impl/AntigravityAgent.js';
import { ClaudeAgent } from './impl/ClaudeAgent.js';
import { CodexAgent } from './impl/CodexAgent.js';
import { OpenCodeAgent } from './impl/OpenCodeAgent.js';
import { VibeAgent } from './impl/VibeAgent.js';

export function createAgentFromConfig(config: AgentConfig): Agent {
  switch (config.type) {
    case 'claude':
      return new ClaudeAgent(config);
    case 'codex':
      return new CodexAgent(config);
    case 'antigravity':
      return new AntigravityAgent(config);
    case 'opencode':
      return new OpenCodeAgent(config);
    case 'vibe':
      return new VibeAgent(config);
    default:
      throw new Error(`Unknown agent type: ${config.type}`);
  }
}
