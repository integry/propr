import { z } from 'zod';

export const SYNTHETIC_SELECTION_STRATEGIES = [
  'round_robin',
  'usage_based',
] as const;

export type SyntheticSelectionStrategy =
  (typeof SYNTHETIC_SELECTION_STRATEGIES)[number];

export const syntheticUsageLimitsSchema = z.object({
  sessionMaxPercent: z.number().finite().min(1).max(100).optional(),
  weeklyMaxPercent: z.number().finite().min(1).max(100).optional(),
}).strict();

export const syntheticModelMemberSchema = z.object({
  id: z.string().uuid(),
  directAgentAlias: z.string().trim().min(1),
  model: z.string().trim().min(1),
  enabled: z.boolean().default(true),
  priority: z.number().int().min(0).max(100).default(100),
  usageLimits: syntheticUsageLimitsSchema.optional(),
}).strict();

export const syntheticModelConfigSchema = z.object({
  id: z.string().regex(
    /^[a-z0-9][a-z0-9-]{0,62}$/,
    'Synthetic model IDs must use lowercase letters, numbers, and hyphens',
  ),
  displayName: z.string().trim().min(1).max(100).optional(),
  enabled: z.boolean().default(true),
  strategy: z.enum(SYNTHETIC_SELECTION_STRATEGIES).default('round_robin'),
  members: z.array(syntheticModelMemberSchema).min(1),
}).strict().superRefine((model, context) => {
  const memberIds = new Set<string>();
  const physicalPairs = new Set<string>();

  model.members.forEach((member, index) => {
    if (memberIds.has(member.id)) {
      context.addIssue({
        code: 'custom',
        path: ['members', index, 'id'],
        message: `Duplicate synthetic member ID '${member.id}'`,
      });
    }
    memberIds.add(member.id);

    const pair = JSON.stringify([member.directAgentAlias, member.model]);
    if (physicalPairs.has(pair)) {
      context.addIssue({
        code: 'custom',
        path: ['members', index],
        message: `Duplicate direct member '${member.directAgentAlias}:${member.model}'`,
      });
    }
    physicalPairs.add(pair);
  });
});

export const syntheticAgentConfigSchema = z.object({
  id: z.string().uuid(),
  alias: z.string().regex(
    /^[a-z0-9][a-z0-9-]{0,62}$/,
    'Synthetic aliases must use lowercase letters, numbers, and hyphens',
  ),
  enabled: z.boolean().default(true),
  defaultModel: z.string().min(1),
  models: z.array(syntheticModelConfigSchema).min(1),
}).strict().superRefine((agent, context) => {
  const modelIds = new Set<string>();
  agent.models.forEach((model, index) => {
    if (modelIds.has(model.id)) {
      context.addIssue({
        code: 'custom',
        path: ['models', index, 'id'],
        message: `Duplicate synthetic model ID '${model.id}'`,
      });
    }
    modelIds.add(model.id);
  });

  if (!agent.models.some(model => model.id === agent.defaultModel && model.enabled)) {
    context.addIssue({
      code: 'custom',
      path: ['defaultModel'],
      message: `Default model '${agent.defaultModel}' is missing or disabled`,
    });
  }
});

export const syntheticAgentConfigsSchema = z.array(syntheticAgentConfigSchema)
  .superRefine((agents, context) => {
    const aliases = new Set<string>();
    const agentIds = new Set<string>();
    agents.forEach((agent, index) => {
      if (agentIds.has(agent.id)) {
        context.addIssue({
          code: 'custom',
          path: [index, 'id'],
          message: `Duplicate synthetic agent ID '${agent.id}'`,
        });
      }
      agentIds.add(agent.id);

      if (aliases.has(agent.alias)) {
        context.addIssue({
          code: 'custom',
          path: [index, 'alias'],
          message: `Duplicate synthetic alias '${agent.alias}'`,
        });
      }
      aliases.add(agent.alias);
    });
  });

export type SyntheticUsageLimits = z.infer<typeof syntheticUsageLimitsSchema>;
export type SyntheticModelMember = z.infer<typeof syntheticModelMemberSchema>;
export type SyntheticModelConfig = z.infer<typeof syntheticModelConfigSchema>;
export type SyntheticAgentConfig = z.infer<typeof syntheticAgentConfigSchema>;

export interface SyntheticDirectAgentReference {
  alias: string;
  enabled: boolean;
  supportedModels: string[];
}

export interface SyntheticReferenceValidationResult {
  errors: string[];
  warnings: string[];
}

export function parseSyntheticAgentConfigs(value: unknown): SyntheticAgentConfig[] {
  return syntheticAgentConfigsSchema.parse(value);
}

export function validateSyntheticAgentReferences(
  syntheticAgents: SyntheticAgentConfig[],
  directAgents: SyntheticDirectAgentReference[],
): SyntheticReferenceValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const directByAlias = new Map(directAgents.map(agent => [agent.alias, agent]));

  for (const syntheticAgent of syntheticAgents) {
    if (directByAlias.has(syntheticAgent.alias)) {
      errors.push(`Synthetic alias '${syntheticAgent.alias}' conflicts with a direct agent alias`);
    }

    for (const syntheticModel of syntheticAgent.models) {
      let enabledMembers = 0;
      for (const member of syntheticModel.members) {
        const directAgent = directByAlias.get(member.directAgentAlias);
        if (!directAgent) {
          errors.push(
            `${syntheticAgent.alias}:${syntheticModel.id} references unknown direct agent '${member.directAgentAlias}'`,
          );
          continue;
        }
        if (!directAgent.supportedModels.includes(member.model)) {
          errors.push(
            `${syntheticAgent.alias}:${syntheticModel.id} references unsupported model `
            + `'${member.directAgentAlias}:${member.model}'`,
          );
          continue;
        }
        if (member.enabled && directAgent.enabled) enabledMembers += 1;
      }

      if (syntheticModel.enabled && enabledMembers === 0) {
        warnings.push(`${syntheticAgent.alias}:${syntheticModel.id} has no enabled direct members`);
      }
    }
  }

  return { errors, warnings };
}

export function findSyntheticReferencesToDirectAgent(
  syntheticAgents: SyntheticAgentConfig[],
  directAgentAlias: string,
): string[] {
  return syntheticAgents.flatMap(agent => agent.models.flatMap(model =>
    model.members.some(member => member.directAgentAlias === directAgentAlias)
      ? [`${agent.alias}:${model.id}`]
      : [],
  ));
}
