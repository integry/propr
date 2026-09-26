import { truncateToSentences } from './setupWizardPrompt';

export interface DraftDisplayNameSource {
  name?: string | null;
  initial_prompt?: string | null;
}

const stripTrailingEllipsis = (value: string): string => value.replace(/\.{3}$/, '').trim();

/**
 * A draft name is "stale prompt derived" when the server generated it from an earlier,
 * shorter version of the prompt the user is still typing. Those names are a strict prefix
 * of the current prompt and shorter than the title the current prompt would produce.
 */
export function isStalePromptDerivedName(name: string | null | undefined, prompt: string | null | undefined): boolean {
  const trimmedName = stripTrailingEllipsis((name || '').trim());
  const trimmedPrompt = (prompt || '').trim();
  if (!trimmedName || !trimmedPrompt) return false;
  if (!trimmedPrompt.startsWith(trimmedName)) return false;
  return trimmedName.length < stripTrailingEllipsis(truncateToSentences(trimmedPrompt)).length;
}

/**
 * Single source of truth for the title shown for a plan. LLM-generated and user-provided
 * names always win; only names derived from a shorter version of the current prompt are
 * refreshed from the prompt so the UI matches what the server stores on the next save.
 */
export function getDraftDisplayName(draft: DraftDisplayNameSource | null | undefined, fallback = 'Untitled Plan'): string {
  const name = (draft?.name || '').trim();
  const prompt = (draft?.initial_prompt || '').trim();
  const promptTitle = prompt ? truncateToSentences(prompt) : '';
  if (!name) return promptTitle || fallback;
  if (isStalePromptDerivedName(name, prompt)) return promptTitle || name;
  return name;
}
