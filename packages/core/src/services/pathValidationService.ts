import { PlanItem } from '../claude/prompts/plannerPrompts.js';
import logger from '../utils/logger.js';

export interface PathValidationOptions {
  correlationId?: string;
}

export class PathValidationService {
  static async validateAndRepair(
    repoPath: string,
    plan: PlanItem[],
    options: PathValidationOptions = {}
  ): Promise<PlanItem[]> {
    const correlatedLogger = options.correlationId
      ? logger.withCorrelation(options.correlationId)
      : logger;

    correlatedLogger.info(
      { taskCount: plan.length },
      'Plan validation complete (file paths are now embedded in body/implementation)'
    );

    return plan;
  }
}
