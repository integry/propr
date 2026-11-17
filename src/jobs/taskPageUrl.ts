/** The web UI page for a task, as linked from PR comments. */
export function taskPageUrl(taskId: string): string;
export function taskPageUrl(taskId: string | undefined): string | undefined;
export function taskPageUrl(taskId: string | undefined): string | undefined {
    if (!taskId) return undefined;
    const webUiUrl = process.env.WEB_UI_URL || process.env.FRONTEND_URL || 'https://gitfix.dev';
    return `${webUiUrl}/tasks/${encodeURIComponent(taskId)}`;
}
