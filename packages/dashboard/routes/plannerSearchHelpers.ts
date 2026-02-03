/**
 * Helper functions for search and scoring in planner routes
 */

interface SearchScore {
  _searchScore: number;
  [key: string]: unknown;
}

interface DraftWithDates {
  updated_at?: string;
  [key: string]: unknown;
}

/**
 * Scores drafts based on search relevance
 */
export function scoreDrafts(
  drafts: Array<{ name?: string; initial_prompt?: string; [key: string]: unknown }>,
  searchWords: string[],
  exactPhrase: string
): SearchScore[] {
  return drafts.map((draft) => {
    const nameLC = (draft.name || '').toLowerCase();
    const promptLC = (draft.initial_prompt || '').toLowerCase();
    let score = 0;

    // Highest score: exact phrase match in name
    if (nameLC.includes(exactPhrase)) score += 100;
    // High score: exact phrase match in prompt
    if (promptLC.includes(exactPhrase)) score += 80;

    // Medium score: all words match (but not as exact phrase)
    const allWordsMatchName = searchWords.every(w => nameLC.includes(w.toLowerCase()));
    const allWordsMatchPrompt = searchWords.every(w => promptLC.includes(w.toLowerCase()));
    if (allWordsMatchName && !nameLC.includes(exactPhrase)) score += 50;
    if (allWordsMatchPrompt && !promptLC.includes(exactPhrase)) score += 40;

    // Lower score: partial word matches (some words match)
    const wordsMatchingName = searchWords.filter(w => nameLC.includes(w.toLowerCase())).length;
    const wordsMatchingPrompt = searchWords.filter(w => promptLC.includes(w.toLowerCase())).length;
    score += wordsMatchingName * 10;
    score += wordsMatchingPrompt * 5;

    return { ...draft, _searchScore: score };
  });
}

/**
 * Sorts drafts by search score (descending) and then by updated_at (descending)
 */
export function sortDraftsByScore(scoredDrafts: SearchScore[]): void {
  scoredDrafts.sort((a, b) => {
    if (b._searchScore !== a._searchScore) return b._searchScore - a._searchScore;
    const aDate = (a as DraftWithDates).updated_at;
    const bDate = (b as DraftWithDates).updated_at;
    return new Date(bDate || 0).getTime() - new Date(aDate || 0).getTime();
  });
}

/**
 * Removes the search score property from drafts
 */
export function removeSearchScore(drafts: SearchScore[]): Array<Record<string, unknown>> {
  return drafts.map((d) => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { _searchScore, ...rest } = d;
    return rest;
  });
}

/**
 * Parses search query into words for matching
 */
export function parseSearchWords(search?: string): string[] {
  return search?.trim().split(/\s+/).filter(w => w.length > 0) || [];
}
