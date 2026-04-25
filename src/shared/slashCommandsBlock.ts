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
        '| `/merge` | Merge this PR when all checks pass | `/merge` |',
        '| `/review` | Request an AI code review | `/review` or `/review claude-sonnet` |',
        '| `/fix` | Ask the AI to fix an issue or apply feedback | `/fix update the error message` |',
        '| `/switch` | Change the AI model for this PR | `/switch claude-opus` |',
        '| `/use` | Specify a model for subsequent commands | `/use claude-sonnet` |',
        '',
        '</details>',
        '',
    ].join('\n');
}
