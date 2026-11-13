// Anthropic publishes a retirement date for each deprecated Claude model
// (https://docs.claude.com/en/docs/about-claude/model-deprecations). A
// deprecated model stays selectable until that date; from then on the API no
// longer serves it, so a Claude run launched with it uses the recommended
// replacement instead.
interface ClaudeModelRetirement {
    /** First UTC day the model is no longer served (YYYY-MM-DD). */
    retiresOn: string;
    successor: string;
}

const CLAUDE_MODEL_RETIREMENTS: Record<string, ClaudeModelRetirement> = {
    // Deprecated 2026-09-30, retired 2026-11-30; Anthropic recommends Sonnet 5.5.
    'claude-sonnet-4-5-20250929': { retiresOn: '2026-11-30', successor: 'claude-sonnet-5-5' },
};

function cleanClaudeModelId(id: string): string {
    const clean = id.trim().toLowerCase().replace(/^claude:/, '');
    if (CLAUDE_MODEL_RETIREMENTS[clean]) return clean;
    // The undated form (claude-sonnet-4-5) names the same snapshot.
    return Object.keys(CLAUDE_MODEL_RETIREMENTS).find(dated => dated.replace(/-\d{8}$/, '') === clean) ?? clean;
}

/** The retirement scheduled for a Claude model ID, dated or undated; undefined for active models. */
export function claudeModelRetirement(id: string): (ClaudeModelRetirement & { id: string }) | undefined {
    const clean = cleanClaudeModelId(id);
    const retirement = CLAUDE_MODEL_RETIREMENTS[clean];
    return retirement ? { id: clean, ...retirement } : undefined;
}

/** True once `now` is on or after the model's retirement date. */
export function isClaudeModelRetired(id: string, now: Date = new Date()): boolean {
    const retirement = claudeModelRetirement(id);
    return !!retirement && now.getTime() >= Date.parse(`${retirement.retiresOn}T00:00:00Z`);
}

/** The model a saved Claude ID runs on: its successor once retired, otherwise the ID unchanged. */
export function currentClaudeModel(id: string, now: Date = new Date()): string {
    return isClaudeModelRetired(id, now) ? claudeModelRetirement(id)!.successor : id;
}
