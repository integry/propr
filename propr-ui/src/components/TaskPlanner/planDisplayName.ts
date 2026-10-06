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

/**
 * Generated step titles often repeat the plan name with a counter
 * ("Agents v1 (3/17): Agent run store"). The outline already shows the
 * step number, so only the distinguishing part of the title is kept.
 */
export const getOutlineTitle = (title: string): string => {
  const stripped = title.replace(/^.*?\(\s*\d+\s*\/\s*\d+\s*\)\s*[:\-–—]\s*/, '').trim();
  return stripped || title.trim();
};

const TAB_LABEL_MAX_WORDS = 3;
const TAB_LABEL_ABBREVIATIONS: Array<[RegExp, string]> = [
  [/\bdatabase\b/gi, 'DB'],
  [/\brepository\b/gi, 'Repo'],
  [/\brepositories\b/gi, 'Repos'],
  [/\bconfiguration\b/gi, 'Config'],
  [/\bdocumentation\b/gi, 'Docs'],
  [/\band\b/gi, '&'],
];
// Leading verbs say what to do, not which feature the step is about.
const TAB_LABEL_LEADING_VERB = /^(?:add|implement|create|build|expose|introduce|update|support|make|wire|extend)\s+/i;
// The subject ends where its qualifiers start: "X for Y", "X with Y", "X: Y", "X, Y", "X (Y)".
const TAB_LABEL_QUALIFIER = /\s+(?:for|with|to|from|in|on|of|via|using|that|so|across|into|per)\s+|\s*[:,;(—–]\s*|\s+-\s+/i;

const capitalize = (word: string): string => (word === '&' || /[A-Z]/.test(word.slice(1)) ? word : word.charAt(0).toUpperCase() + word.slice(1));

/**
 * Short feature label for the step tabs ("Shared contracts for agent definitions,
 * runs, …" → "Shared Contracts"). Tabs are an index, so they show only the
 * step's subject; the full title stays in the specification and the tooltip.
 */
export const getTabLabel = (title: string): string => {
  const outlineTitle = getOutlineTitle(title);
  const subject = outlineTitle.replace(TAB_LABEL_LEADING_VERB, '').split(TAB_LABEL_QUALIFIER)[0].trim() || outlineTitle;
  const abbreviated = TAB_LABEL_ABBREVIATIONS.reduce((text, [pattern, short]) => text.replace(pattern, short), subject);
  let words = abbreviated.split(/\s+/).filter(Boolean);
  if (words.filter(word => word !== '&').length > TAB_LABEL_MAX_WORDS) {
    // "DB migration & definition store" keeps its first half rather than stopping mid-phrase.
    const joinIndex = words.indexOf('&');
    words = joinIndex > 0 && joinIndex <= TAB_LABEL_MAX_WORDS ? words.slice(0, joinIndex) : words.slice(0, TAB_LABEL_MAX_WORDS);
  }
  if (words[words.length - 1] === '&') words = words.slice(0, -1);
  return words.map(capitalize).join(' ') || outlineTitle;
};
