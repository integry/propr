/**
 * Builds an expandable HTML <details> block documenting available ProPR slash commands.
 * Used in both PR body and completion comments for discoverability.
 */
export function buildSlashCommandsBlock(): string {
    return [
        '<details>',
        '<summary>💡 <strong>ProPR Slash Commands</strong></summary>',
        '',
        '| Command | Description | Example |',
        '|---------|-------------|---------|',
        '| `/merge` | Merge target branch into this PR and resolve conflicts | `/merge` |',
        '| `/review` | Request an AI code review | `/review` or `/review claude-sonnet` |',
        '| `/fix` | Implement fixes for issues found by `/review` | `/fix` or `/fix address the null check issue` |',
        '| `/switch` | Change the AI model for this PR | `/switch claude-opus` |',
        '| `/use` | Override the model for a single follow-up run | `/use claude-sonnet` |',
        '',
        '</details>',
        '',
    ].join('\n');
}
