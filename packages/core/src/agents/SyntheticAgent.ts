import type { SyntheticAgentConfig } from '@propr/shared';
import type { Agent, AgentConfig, AgentExecutionResult, AgentTaskOptions, AnalysisResult, AnalyzeOptions } from './types.js';
import { estimateTaskRequiredTokens, type SyntheticRoutingService } from '../services/syntheticRoutingService.js';
import { estimateTokens } from '../utils/tokenCalculation.js';

/** Agent facade that keeps the requested virtual identity while routing calls centrally. */
export class SyntheticAgent implements Agent {
  readonly config: AgentConfig;

  constructor(
    readonly syntheticConfig: SyntheticAgentConfig,
    private readonly routing: SyntheticRoutingService,
  ) {
    this.config = {
      id: syntheticConfig.id,
      // Existing consumers use this only for capability checks. The actual type
      // and credentials always come from the selected physical member.
      type: 'claude',
      alias: syntheticConfig.alias,
      enabled: syntheticConfig.enabled,
      dockerImage: '',
      configPath: '',
      supportedModels: syntheticConfig.models.filter(model => model.enabled).map(model => model.id),
      defaultModel: syntheticConfig.defaultModel,
    };
  }

  analyze(prompt: string, options: AnalyzeOptions = {}): Promise<AnalysisResult> {
    const session = this.routing.begin({
      requestedAgentAlias: this.config.alias,
      requestedModel: options.model || this.config.defaultModel,
      promptTokens: estimateTokens(`${prompt}${options.context || ''}`),
    });
    return session.analyze(prompt, options);
  }

  executeTask(options: AgentTaskOptions): Promise<AgentExecutionResult> {
    const session = this.routing.begin({
      requestedAgentAlias: this.config.alias,
      requestedModel: options.model || this.config.defaultModel,
      requiredTokens: estimateTaskRequiredTokens(options),
    });
    return session.executeTask(options);
  }

  async healthCheck(): Promise<boolean> {
    try {
      const session = this.routing.begin({
        requestedAgentAlias: this.config.alias,
        requestedModel: this.config.defaultModel,
        requiredTokens: 0,
      });
      const selection = await session.select();
      return selection.physicalAgent.healthCheck();
    } catch {
      return false;
    }
  }
}
