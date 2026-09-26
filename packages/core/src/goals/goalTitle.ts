import { loadSummarizationSettings } from '../config/configManager.js';
import { resolveConfiguredModel } from '../config/configuredModel.js';
import { runLightweightLLMAnalysis } from '../claude/claudeService.js';
import { cleanGeneratedTitle } from '../services/taskExecutionHelpers.js';

export const MAX_GOAL_TITLE_LENGTH = 140;

export function buildGoalTitlePrompt(objective: string): string {
  return `Summarize the following coding goal as a short, descriptive task title (5-8 words).

STRICT FORMATTING RULES:
- Output ONLY the title text, nothing else
- Do NOT use markdown formatting
- Do NOT wrap the title in quotes
- Do NOT prefix with "Title:" or "Goal:"
- Use plain text only

Goal description:
${objective}

Title (plain text only):`;
}

export function normalizeGoalTitle(value: string): string {
  const cleaned = cleanGeneratedTitle(value)
    .replace(/^goal\s*:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';
  return cleaned.length > MAX_GOAL_TITLE_LENGTH
    ? `${cleaned.slice(0, MAX_GOAL_TITLE_LENGTH - 3).trimEnd()}...`
    : cleaned;
}

/** A bounded display fallback used when title generation is unavailable. */
export function goalTitleFallback(objective: string): string {
  const normalized = objective.replace(/^\s*\/goal\s+/i, '').replace(/\s+/g, ' ').trim();
  const firstSentence = normalized.match(/^.*?[.!?](?:\s|$)/)?.[0]?.trim() || normalized;
  return normalizeGoalTitle(firstSentence) || 'Untitled goal';
}

interface GoalTitleGenerationOptions {
  objective: string;
  repository: string;
  taskId: string;
  correlationId?: string;
}

interface GoalTitleGenerationDependencies {
  loadSettings?: typeof loadSummarizationSettings;
  resolveModel?: typeof resolveConfiguredModel;
  runAnalysis?: typeof runLightweightLLMAnalysis;
}

/** Generate the same concise, summarization-model-backed title used for task presentation. */
export async function generateGoalTitle(
  options: GoalTitleGenerationOptions,
  dependencies: GoalTitleGenerationDependencies = {},
): Promise<string> {
  const loadSettings = dependencies.loadSettings ?? loadSummarizationSettings;
  const resolveModel = dependencies.resolveModel ?? resolveConfiguredModel;
  const runAnalysis = dependencies.runAnalysis ?? runLightweightLLMAnalysis;
  const settings = await loadSettings();
  const configuredModel = settings.agent_alias?.trim();
  if (!configuredModel) throw new Error('No summarization model configured for goal title generation');
  const model = await resolveModel(configuredModel);
  const [repoOwner, repoName] = options.repository.split('/');
  const response = await runAnalysis({
    prompt: buildGoalTitlePrompt(options.objective),
    model,
    correlationId: options.correlationId ?? options.taskId,
    worktreePath: '',
    githubToken: '',
    issueRef: { number: 0, repoOwner, repoName },
    taskId: options.taskId,
    executionType: 'title-generation',
    metadata: { taskKind: 'goal-title-generation', configuredVia: 'summarization.agent_alias' },
    timeoutMs: 30_000,
  });
  const title = normalizeGoalTitle(response);
  if (!title) throw new Error('Goal title generation returned an empty title');
  return title;
}
