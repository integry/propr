import { formatGeminiModelVariant } from './modelDisplay';

/**
 * Map of raw Agent Tank metric keys to human-readable labels.
 */
export const METRIC_KEY_LABELS: Record<string, string> = {
  session: 'Session',
  weeklyAll: 'Weekly',
  weeklySonnet: 'Sonnet',
  weeklyFable: 'Fable',
  weeklyOpus: 'Opus',
  weeklyHaiku: 'Haiku',
  fiveHour: 'Five Hour',
  weekly: 'Weekly',
  daily: 'Daily',
  monthly: 'Monthly',
  allowance: 'Allowance',
};

// Agent Tank reports Antigravity quotas as "<group> · <window> Limit Remaining".
// Every usage figure already reads as remaining capacity, so the trailing word
// is noise that pushes the informative part out of a truncated label.
export function stripRemainingSuffix(name: string): string {
  return name.replace(/\s+Remaining$/i, '').trim();
}

// A Gemini model key is a model id ("gemini-2.5-flash") or its spaced form
// with a version ("Gemini 2.5 Flash"). Quota window keys such as
// "Gemini · Weekly Limit Remaining" are neither, and keep their prefix.
const GEMINI_MODEL_KEY = /^gemini(-|\s+\d)/i;

export function humanizeMetricKey(key: string): string {
  if (METRIC_KEY_LABELS[key]) return METRIC_KEY_LABELS[key];
  if (key.includes(' · ')) return stripRemainingSuffix(key);
  // Shorten Gemini model names (e.g. "Gemini-2.5-flash" → "2.5 Flash")
  if (GEMINI_MODEL_KEY.test(key)) {
    return formatGeminiModelVariant(key.toLowerCase().replace(/\s/g, '-'));
  }
  // Already humanized (starts with uppercase) — return as-is
  if (/^[A-Z]/.test(key)) return key;
  // Split camelCase and title-case each word
  return key
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^./, c => c.toUpperCase());
}
