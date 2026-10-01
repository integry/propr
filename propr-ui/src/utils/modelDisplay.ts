import { MODEL_INFO_MAP } from '../config/modelDefinitions';

interface ModelDisplayNameOptions {
  compactGemini?: boolean;
  compactAntigravity?: boolean;
}

const GEMINI_PREFIX = 'gemini-';
const ANTIGRAVITY_PREFIX = 'antigravity-';

function toTitleCase(value: string): string {
  if (!value) return value;
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}

export function formatGeminiModelVariant(modelId: string): string {
  if (!modelId.startsWith(GEMINI_PREFIX)) return modelId;

  return modelId
    .slice(GEMINI_PREFIX.length)
    .split('-')
    .filter(Boolean)
    .map(part => /^\d+(\.\d+)*$/.test(part) ? part : toTitleCase(part))
    .join(' ');
}

export function getModelDisplayName(modelId: string, options: ModelDisplayNameOptions = {}): string {
  const modelInfo = MODEL_INFO_MAP[modelId];

  if (options.compactAntigravity && modelId.startsWith(ANTIGRAVITY_PREFIX)) {
    return modelInfo?.name.replace(/^Antigravity\s+/i, '') || modelId.slice(ANTIGRAVITY_PREFIX.length);
  }

  if (options.compactGemini && modelId.startsWith(GEMINI_PREFIX)) {
    return modelInfo?.name.replace(/^Gemini\s+/i, '') || formatGeminiModelVariant(modelId);
  }

  return modelInfo?.name || modelId;
}

/** Families whose name is an acronym rather than a word. */
const UPPERCASE_MODEL_WORDS = new Set(['gpt', 'glm', 'llm']);

/**
 * A readable name for a model id the catalogue does not know.
 *
 * Usage history outlives the catalogue, so a report can hold ids such as
 * `gpt-5.6` that no longer have an entry. Printed raw beside `Claude Opus 5.5`
 * they read as two different kinds of thing, so they get the catalogue's own
 * convention: words title-cased, version digits joined with dots
 * (`claude-opus-5-5` → `Claude Opus 5.5`), an acronym family upper-cased and
 * hyphenated to its version (`gpt-5.6-mini` → `GPT-5.6 Mini`), and a trailing
 * release date dropped.
 */
export function humanizeModelId(modelId: string): string {
  const parts = modelId.split('-').filter(Boolean);
  if (parts.length > 1 && /^\d{8}$/.test(parts[parts.length - 1])) parts.pop();

  const words: string[] = [];
  for (const part of parts) {
    const previous = words[words.length - 1];
    const isVersion = /^\d+(\.\d+)*$/.test(part);
    if (isVersion && previous !== undefined && /^\d+(\.\d+)*$/.test(previous)) {
      words[words.length - 1] = `${previous}.${part}`;
    } else if (isVersion && previous !== undefined && UPPERCASE_MODEL_WORDS.has(previous.toLowerCase())) {
      words[words.length - 1] = `${previous}-${part}`;
    } else if (UPPERCASE_MODEL_WORDS.has(part.toLowerCase())) {
      words.push(part.toUpperCase());
    } else {
      words.push(isVersion ? part : toTitleCase(part));
    }
  }
  return words.join(' ') || modelId;
}

/**
 * The catalogue name for a model, or a humanized id when it has none, so a
 * list of models never mixes display names with raw slugs. A provider prefix
 * (`openai/gpt-5.5`) is looked up without it.
 */
export function formatModelName(modelId: string): string {
  const bare = modelId.slice(modelId.lastIndexOf('/') + 1);
  return MODEL_INFO_MAP[modelId]?.name || MODEL_INFO_MAP[bare]?.name || humanizeModelId(bare);
}
