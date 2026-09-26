/**
 * Task IDs are stored in VARCHAR(255) columns and are also used as URL path
 * segments. Keep generated IDs within that shared storage and API contract.
 */
export const MAX_TASK_ID_LENGTH = 255;
export const TASK_ID_PATTERN = /^[a-zA-Z0-9_.-]+$/;
const UUID_SUFFIX_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const LEGACY_PROVIDER_TASK_ID_PATTERN = new RegExp(
  `^[a-zA-Z0-9_.-]+-[0-9]+-[a-zA-Z0-9_.-]+-[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+-${UUID_SUFFIX_PATTERN}$`,
  'i',
);

const MAX_TASK_ID_COMPONENT_LENGTH = 80;

/** Convert an external identifier, such as a model ID, into one task-ID component. */
export function sanitizeTaskIdComponent(value: string, fallback = 'value'): string {
  const sanitized = value
    .trim()
    .slice(0, MAX_TASK_ID_COMPONENT_LENGTH)
    .replace(/[^a-zA-Z0-9_.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '');

  return sanitized || fallback;
}

/** Recognize issue-task IDs created before provider separators were sanitized. */
export function isLegacyProviderTaskId(value: string): boolean {
  return LEGACY_PROVIDER_TASK_ID_PATTERN.test(value);
}

export interface IssueTaskIdParts {
  repoOwner: string;
  repoName: string;
  issueNumber: number;
  agentAlias: string;
  modelName: string;
  correlationId: string;
}

/**
 * Build the stable task-history ID for an issue execution.
 *
 * The correlation ID remains intact when the human-readable prefix needs to be
 * shortened, preserving uniqueness without allowing provider-qualified model
 * IDs (for example `openai/gpt-5.6`) to introduce URL path separators.
 */
export function buildIssueTaskId(parts: IssueTaskIdParts): string {
  const prefix = [
    sanitizeTaskIdComponent(parts.repoOwner, 'owner'),
    sanitizeTaskIdComponent(parts.repoName, 'repository'),
    sanitizeTaskIdComponent(String(parts.issueNumber), 'issue'),
    sanitizeTaskIdComponent(parts.agentAlias, 'agent'),
    sanitizeTaskIdComponent(parts.modelName, 'model'),
  ].join('-');
  const correlationId = sanitizeTaskIdComponent(parts.correlationId, 'correlation');
  const suffix = `-${correlationId}`;
  const prefixBudget = MAX_TASK_ID_LENGTH - suffix.length;
  const boundedPrefix = prefix
    .slice(0, prefixBudget)
    .replace(/[._-]+$/g, '') || 'task';

  return `${boundedPrefix}${suffix}`;
}
