/**
 * Short-lived cache of semantic search relevance results.
 */

import type { findRelevantFiles } from './relevanceService.js';

/**
 * Recent relevance results, so paging through or repeating a semantic search
 * does not rerun the relevance engine (and its LLM ranking pass) each call.
 * Keyed on everything scoring depends on, including the resolved commit and
 * the index build, so a moved ref or a re-index is never answered from cache.
 */
const RELEVANCE_CACHE_TTL_MS = 60_000;
const MAX_RELEVANCE_CACHE_ENTRIES = 50;
type RelevanceRun = ReturnType<typeof findRelevantFiles>;
const relevanceCache = new Map<string, { expiresAt: number; result: RelevanceRun }>();

/** Drops cached relevance results; exposed for tests. */
export function clearRelevanceCache(): void {
  relevanceCache.clear();
}

export function cachedRelevance(key: string, useSummaryScoring: boolean, score: () => RelevanceRun): RelevanceRun {
  const now = Date.now();
  for (const [candidate, entry] of relevanceCache) {
    if (entry.expiresAt > now && relevanceCache.size < MAX_RELEVANCE_CACHE_ENTRIES) break;
    relevanceCache.delete(candidate);
  }
  const hit = relevanceCache.get(key);
  if (hit && hit.expiresAt > now) return hit.result;

  const result = score();
  relevanceCache.set(key, { expiresAt: now + RELEVANCE_CACHE_TTL_MS, result });
  // Failures, and summary scoring that failed to contribute, are not remembered.
  const forget = () => { if (relevanceCache.get(key)?.result === result) relevanceCache.delete(key); };
  result.then(value => { if (useSummaryScoring && !value.usedSummaryScoring) forget(); }, forget);
  return result;
}

export interface RelevanceCacheKeyParts {
  repoPath: string;
  repository: string;
  commit: string;
  query: string;
  indexBranch: string;
  usedIndex: boolean;
  agent?: { config: { alias?: string; defaultModel?: string } };
  /** Identifies the index build: its commit and completion time. */
  indexRow: { last_indexed_hash: string | null; last_indexed_at: Date | string | null } | null;
}

export function relevanceCacheKey(parts: RelevanceCacheKeyParts): string {
  const { repoPath, repository, commit, query, indexBranch, usedIndex, agent, indexRow } = parts;
  const indexedAt = indexRow?.last_indexed_at;
  return JSON.stringify([repoPath, repository, commit, query, indexBranch, usedIndex,
    agent?.config.alias ?? null, agent?.config.defaultModel ?? null,
    indexRow?.last_indexed_hash ?? null, indexedAt instanceof Date ? indexedAt.toISOString() : indexedAt ?? null]);
}
