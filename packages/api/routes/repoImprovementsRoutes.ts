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

export function createRepoImprovementsRoutes() {
  async function postImprovements(req: Request, res: Response): Promise<void> {
    const correlationId = generateCorrelationId();

    try {
      const {
        repository,
        branch,
        categories,
        customPrompt,
        referenceRepoId
      } = req.body as RepoImprovementsRequest;

      // Validate required fields
      if (!repository || typeof repository !== 'string') {
        res.status(400).json({ error: 'repository is required and must be a string' });
        return;
      }

      // Parse repository into owner and name
      const [owner, repoName] = repository.split('/');
      if (!owner || !repoName) {
        res.status(400).json({ error: 'Invalid repository format. Expected "owner/repo"' });
        return;
      }

      // Validate categories array
      if (!Array.isArray(categories)) {
        res.status(400).json({ error: 'categories must be an array' });
        return;
      }

      // Validate that at least one category is provided or customPrompt is present
      const hasCategories = categories.length > 0;
      const hasCustomPrompt = customPrompt && typeof customPrompt === 'string' && customPrompt.trim().length > 0;

      if (!hasCategories && !hasCustomPrompt) {
        res.status(400).json({ error: 'At least one category or a custom prompt is required' });
        return;
      }

      // Validate category values if provided
      const validCategories: ImprovementCategory[] = [
        'code-quality',
        'performance',
        'security',
        'testing',
        'documentation',
        'architecture'
      ];

      for (const category of categories) {
        if (!validCategories.includes(category)) {
          res.status(400).json({
            error: `Invalid category: ${category}. Valid categories are: ${validCategories.join(', ')}`
          });
          return;
        }
      }

      // Log the request parameters for debugging
      console.log('[repo-improvements] Request received:', {
        correlationId,
        repository,
        branch: branch || 'default',
        categories,
        customPrompt: customPrompt ? `${customPrompt.substring(0, 50)}...` : undefined,
        referenceRepoId: referenceRepoId || null
      });

      // Get GitHub authentication token
      let authToken: string;
      try {
        authToken = await getGitHubInstallationToken();
      } catch {
        res.status(500).json({ error: 'Failed to obtain GitHub authentication' });
        return;
      }

      // Ensure the repository is cloned/accessible
      const repoUrl = `https://github.com/${owner}/${repoName}.git`;
      let worktreePath: string;
      try {
        worktreePath = await ensureRepoCloned({ repoUrl, owner, repoName, authToken, baseBranch: branch });
      } catch (cloneError) {
        res.status(500).json({ error: `Failed to access repository: ${(cloneError as Error).message}` });
        return;
      }

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
      let referenceContext: string | null = null;
      if (referenceRepoId) {
        try {
          const referenceSummaryResult = await buildSummaryContext({
            repoName: referenceRepoId,
            correlationId
          });
          if (referenceSummaryResult.context) {
            referenceContext = referenceSummaryResult.context;
            console.log('[repo-improvements] Reference context built:', {
              correlationId,
              referenceRepoId,
              fileSummaryCount: referenceSummaryResult.fileSummaryCount,
              dirSummaryCount: referenceSummaryResult.dirSummaryCount,
              estimatedTokens: referenceSummaryResult.estimatedTokens
            });
          }
        } catch (refError) {
          console.warn('[repo-improvements] Failed to build reference context:', {
            correlationId,
            referenceRepoId,
            error: (refError as Error).message
          });
          // Continue without reference context - not a fatal error
        }
      }

      // Build the LLM prompt
      const prompt = buildImprovementsPrompt(
        categories,
        customPrompt,
        targetSummaryResult.context,
        referenceContext
      );

      // Get model settings
      const settings = await loadSettings();
      const model = settings.planner_context_model || 'haiku';

      // Call the LLM
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

      // Parse the LLM response as JSON array
      let suggestions: ImprovementSuggestion[];
      try {
        suggestions = parseLlmJson<ImprovementSuggestion[]>(llmResponse);

        // Validate the parsed suggestions
        if (!Array.isArray(suggestions)) {
          throw new Error('LLM response is not an array');
        }

        // Validate each suggestion has required fields
        for (const suggestion of suggestions) {
          if (typeof suggestion.title !== 'string' || typeof suggestion.description !== 'string') {
            throw new Error('Suggestion missing required title or description field');
          }
        }

        console.log('[repo-improvements] Successfully parsed suggestions:', {
          correlationId,
          count: suggestions.length
        });
      } catch (parseError) {
        console.error('[repo-improvements] Failed to parse LLM response:', {
          correlationId,
          error: (parseError as Error).message,
          responsePreview: llmResponse.substring(0, 500)
        });
        res.status(500).json({
          error: 'Failed to parse improvement suggestions from LLM response'
        });
        return;
      }

      // Return success response with suggestions
      res.json({
        success: true,
        suggestions,
        metadata: {
          repository,
          branch: branch || 'HEAD',
          categories,
          referenceRepoId: referenceRepoId || null,
          suggestionCount: suggestions.length
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
