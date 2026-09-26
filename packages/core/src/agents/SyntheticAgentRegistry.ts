import logger from '../utils/logger.js';
import { loadSyntheticAgents } from '../config/configManager.js';
import {
  SyntheticRoutingService,
  type BeginSyntheticRoutingOptions,
  type SyntheticRoutingSession,
} from '../services/syntheticRoutingService.js';
import type { Agent } from './types.js';
import { SyntheticAgent } from './SyntheticAgent.js';

export type { BeginSyntheticRoutingOptions, SyntheticRoutingSession } from '../services/syntheticRoutingService.js';

export class SyntheticAgentRegistry {
  private routingService: SyntheticRoutingService | null = null;

  constructor(
    private readonly agents: Map<string, Agent>,
    private readonly agentsByAlias: Map<string, Agent>,
  ) {}

  begin(options: BeginSyntheticRoutingOptions): SyntheticRoutingSession {
    this.routingService ??= this.createRoutingService();
    return this.routingService.begin(options);
  }

  async register(): Promise<void> {
    const configs = await loadSyntheticAgents();
    this.routingService = this.createRoutingService();
    for (const config of configs) {
      if (!config.enabled) continue;
      if (this.agentsByAlias.has(config.alias)) {
        logger.error({ syntheticAgentAlias: config.alias }, 'Synthetic agent alias conflicts with a registered direct agent');
        continue;
      }
      if (this.agents.has(config.id)) {
        logger.error({ syntheticAgentId: config.id, syntheticAgentAlias: config.alias }, 'Synthetic agent ID conflicts with a registered direct agent');
        continue;
      }
      const agent = new SyntheticAgent(config, this.routingService);
      this.agents.set(config.id, agent);
      this.agentsByAlias.set(config.alias, agent);
      logger.info({ syntheticAgentAlias: config.alias, modelCount: config.models.length }, 'Synthetic agent registered');
    }
  }

  clear(): void {
    this.routingService = null;
  }

  private createRoutingService(): SyntheticRoutingService {
    return new SyntheticRoutingService({
      getDirectAgent: alias => {
        const agent = this.agentsByAlias.get(alias);
        return agent instanceof SyntheticAgent ? undefined : agent;
      },
    });
  }
}
