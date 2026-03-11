import { Request, Response } from 'express';
import {
  buildSummaryContext,
  runLightweightLLMAnalysis,
  getGitHubInstallationToken,
  ensureRepoCloned,
  generateCorrelationId,
  loadSettings,
  parseLlmJson
} from '@propr/core';

/**
 * Improvement categories available for repository analysis
 */
type ImprovementCategory =
  | 'code-quality'
  | 'performance'
  | 'security'
  | 'testing'
  | 'documentation'
  | 'architecture';

interface RepoImprovementsRequest {
  repository: string;
  branch?: string;
  categories: ImprovementCategory[];
  customPrompt?: string;
  referenceRepoId?: string | null;
}

/**
 * Represents a single improvement suggestion
 */
interface ImprovementSuggestion {
  title: string;
  description: string;
}

/**
 * Category descriptions for prompt context
 */
const CATEGORY_DESCRIPTIONS: Record<ImprovementCategory, string> = {
  'code-quality': 'Identify code smells, refactoring opportunities, and maintainability improvements',
  'performance': 'Find performance bottlenecks, optimization opportunities, and resource inefficiencies',
  'security': 'Detect potential security vulnerabilities, unsafe practices, and security improvements',
  'testing': 'Suggest test coverage improvements, missing test cases, and testing best practices',
  'documentation': 'Identify missing or outdated documentation, unclear code sections, and documentation improvements',
  'architecture': 'Analyze architectural patterns, suggest structural improvements, and identify design issues'
};

/**
 * Builds the LLM prompt for generating improvement suggestions
 */
function buildImprovementsPrompt(
  categories: ImprovementCategory[],
  customPrompt: string | undefined,
  targetContext: string,
  referenceContext: string | null
): string {
  const categoryList = categories.length > 0
    ? categories.map(cat => `- ${cat}: ${CATEGORY_DESCRIPTIONS[cat]}`).join('\n')
    : '- General: Provide general improvement suggestions across all areas';

  const referenceSection = referenceContext
    ? `
## Reference Repository Context
The following context is from a reference repository that can be used as an example of best practices:

${referenceContext}

Use this reference repository as a guide for suggesting improvements. Look for patterns, practices, and conventions from the reference that could be applied to the target repository.
`
    : '';

  const customSection = customPrompt
    ? `
## Additional User Instructions
${customPrompt}
`
    : '';

  return `You are an expert code reviewer tasked with generating actionable improvement suggestions for a codebase.

## Target Repository Context
The following summaries describe the structure and contents of the repository to analyze:

${targetContext || 'No codebase summaries available. Provide general best practice suggestions.'}
${referenceSection}
## Categories to Focus On
${categoryList}
${customSection}
## Task
Generate a list of specific, actionable improvement suggestions based on the repository context and requested categories.

## Output Format
You MUST respond with ONLY a valid JSON array. Do not include any text before or after the JSON.
Each item in the array must have exactly these two fields:
- "title": A concise title for the improvement (max 100 characters)
- "description": A detailed description explaining the issue and how to fix it (2-4 sentences)

Example output format:
[
  {
    "title": "Add input validation to user forms",
    "description": "The user registration and login forms lack proper input validation. Add client-side and server-side validation to prevent invalid data submission and improve security against injection attacks."
  },
  {
    "title": "Implement caching for database queries",
    "description": "Frequently accessed data queries are being executed repeatedly without caching. Consider implementing a caching layer using Redis or in-memory caching to reduce database load and improve response times."
  }
]

Generate between 3 and 10 improvement suggestions based on the available context. Be specific and actionable.

CRITICAL: Your entire response must be a valid JSON array. No explanatory text, no markdown formatting, no code blocks. Just the JSON array.`;
}

/**
 * Valid improvement categories
 */
const VALID_CATEGORIES: ImprovementCategory[] = [
  'code-quality',
  'performance',
  'security',
  'testing',
  'documentation',
  'architecture'
];

/**
 * Validation result type
 */
interface ValidationResult {
  valid: boolean;
  error?: string;
  owner?: string;
  repoName?: string;
}

/**
 * Validates the request body for improvements endpoint
 */
function validateImprovementsRequest(body: RepoImprovementsRequest): ValidationResult {
  const { repository, categories, customPrompt } = body;

  if (!repository || typeof repository !== 'string') {
    return { valid: false, error: 'repository is required and must be a string' };
  }

  const [owner, repoName] = repository.split('/');
  if (!owner || !repoName) {
    return { valid: false, error: 'Invalid repository format. Expected "owner/repo"' };
  }

  if (!Array.isArray(categories)) {
    return { valid: false, error: 'categories must be an array' };
  }

  const hasCategories = categories.length > 0;
  const hasCustomPrompt = customPrompt && typeof customPrompt === 'string' && customPrompt.trim().length > 0;

  if (!hasCategories && !hasCustomPrompt) {
    return { valid: false, error: 'At least one category or a custom prompt is required' };
  }

  for (const category of categories) {
    if (!VALID_CATEGORIES.includes(category)) {
      return {
        valid: false,
        error: `Invalid category: ${category}. Valid categories are: ${VALID_CATEGORIES.join(', ')}`
      };
    }
  }

  return { valid: true, owner, repoName };
}

/**
 * Builds reference context from a reference repository
 */
async function buildReferenceContext(
  referenceRepoId: string,
  correlationId: string
): Promise<string | null> {
  try {
    const referenceSummaryResult = await buildSummaryContext({
      repoName: referenceRepoId,
      correlationId
    });
    if (referenceSummaryResult.context) {
      console.log('[repo-improvements] Reference context built:', {
        correlationId,
        referenceRepoId,
        fileSummaryCount: referenceSummaryResult.fileSummaryCount,
        dirSummaryCount: referenceSummaryResult.dirSummaryCount,
        estimatedTokens: referenceSummaryResult.estimatedTokens
      });
      return referenceSummaryResult.context;
    }
  } catch (refError) {
    console.warn('[repo-improvements] Failed to build reference context:', {
      correlationId,
      referenceRepoId,
      error: (refError as Error).message
    });
  }
  return null;
}

/**
 * Parses and validates the LLM response into suggestions
 */
function parseAndValidateSuggestions(
  llmResponse: string,
  correlationId: string
): { suggestions: ImprovementSuggestion[] } | { error: string } {
  try {
    const suggestions = parseLlmJson<ImprovementSuggestion[]>(llmResponse);

    if (!Array.isArray(suggestions)) {
      throw new Error('LLM response is not an array');
    }

    for (const suggestion of suggestions) {
      if (typeof suggestion.title !== 'string' || typeof suggestion.description !== 'string') {
        throw new Error('Suggestion missing required title or description field');
      }
    }

    console.log('[repo-improvements] Successfully parsed suggestions:', {
      correlationId,
      count: suggestions.length
    });

    return { suggestions };
  } catch (parseError) {
    console.error('[repo-improvements] Failed to parse LLM response:', {
      correlationId,
      error: (parseError as Error).message,
      responsePreview: llmResponse.substring(0, 500)
    });
    return { error: 'Failed to parse improvement suggestions from LLM response' };
  }
}

export function createRepoImprovementsRoutes() {
  async function postImprovements(req: Request, res: Response): Promise<void> {
    const correlationId = generateCorrelationId();

    try {
      const body = req.body as RepoImprovementsRequest;
      const { repository, branch, categories, customPrompt, referenceRepoId } = body;

      // Validate request
      const validation = validateImprovementsRequest(body);
      if (!validation.valid) {
        res.status(400).json({ error: validation.error });
        return;
      }

      const { owner, repoName } = validation as { owner: string; repoName: string };

      console.log('[repo-improvements] Request received:', {
        correlationId,
        repository,
        branch: branch || 'default',
        categories,
        customPrompt: customPrompt ? `${customPrompt.substring(0, 50)}...` : undefined,
        referenceRepoId: referenceRepoId || null
      });

      // Get GitHub authentication token
      const authToken = await getGitHubInstallationToken();

      // Ensure the repository is cloned/accessible
      const repoUrl = `https://github.com/${owner}/${repoName}.git`;
      const worktreePath = await ensureRepoCloned({ repoUrl, owner, repoName, authToken, baseBranch: branch });

      // Build context for the target repository
      const targetSummaryResult = await buildSummaryContext({
        repoName: repository,
        correlationId
      });

      console.log('[repo-improvements] Target context built:', {
        correlationId,
        fileSummaryCount: targetSummaryResult.fileSummaryCount,
        dirSummaryCount: targetSummaryResult.dirSummaryCount,
        estimatedTokens: targetSummaryResult.estimatedTokens
      });

      // Build context for reference repository if provided
      const referenceContext = referenceRepoId
        ? await buildReferenceContext(referenceRepoId, correlationId)
        : null;

      // Build the LLM prompt
      const prompt = buildImprovementsPrompt(
        categories,
        customPrompt,
        targetSummaryResult.context,
        referenceContext
      );

      // Get model settings and call the LLM
      const settings = await loadSettings();
      const model = settings.planner_context_model || 'haiku';
      const issueRef = { number: 0, repoOwner: owner, repoName };

      const llmResponse = await runLightweightLLMAnalysis({
        prompt,
        model,
        correlationId,
        worktreePath,
        githubToken: authToken,
        issueRef,
        executionType: 'other',
        metadata: {
          type: 'repo-improvements',
          repository,
          branch,
          categories,
          hasReferenceRepo: !!referenceRepoId
        }
      });

      console.log('[repo-improvements] LLM response received:', {
        correlationId,
        responseLength: llmResponse.length
      });

      // Parse and validate the LLM response
      const parseResult = parseAndValidateSuggestions(llmResponse, correlationId);
      if ('error' in parseResult) {
        res.status(500).json({ error: parseResult.error });
        return;
      }

      // Return success response with suggestions
      res.json({
        success: true,
        suggestions: parseResult.suggestions,
        metadata: {
          repository,
          branch: branch || 'HEAD',
          categories,
          referenceRepoId: referenceRepoId || null,
          suggestionCount: parseResult.suggestions.length
        }
      });
    } catch (error) {
      console.error('Error in /api/repos/improvements:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Internal server error'
      });
    }
  }

  return {
    postImprovements
  };
}
