// Repository Improvements API
import { API_BASE_URL, handleApiResponse } from './proprApi';
import { ImprovementCategory } from '../components/Repositories/RepoImprovementsPanel.types';

/**
 * Request payload for generating repository improvement suggestions
 */
export interface GenerateRepoImprovementsRequest {
  /** The full repository name (e.g., "owner/repo") */
  repository: string;
  /** The branch to analyze */
  branch?: string;
  /** Selected improvement categories to focus on */
  categories: ImprovementCategory[];
  /** Custom instructions/prompt from the user */
  customPrompt?: string;
  /** Optional reference repository ID for best practices comparison */
  referenceRepoId?: string | null;
}

/**
 * Represents a single improvement suggestion
 */
export interface ImprovementSuggestion {
  title: string;
  description: string;
}

/**
 * Metadata about the improvement generation request
 */
export interface ImprovementsMetadata {
  repository: string;
  branch: string;
  categories: ImprovementCategory[];
  referenceRepoId: string | null;
  suggestionCount: number;
}

/**
 * Response from the repository improvements endpoint
 */
export interface GenerateRepoImprovementsResponse {
  success: boolean;
  suggestions?: ImprovementSuggestion[];
  metadata?: ImprovementsMetadata;
  message?: string;
  error?: string;
}

/**
 * Generates improvement suggestions for a repository based on selected categories
 * and custom instructions.
 *
 * @param request - The improvement request parameters
 * @returns The response indicating success or error
 */
export const generateRepoImprovements = async (
  request: GenerateRepoImprovementsRequest
): Promise<GenerateRepoImprovementsResponse> => {
  const response = await fetch(`${API_BASE_URL}/api/repos/improvements`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};
