import { compactNotificationRecap } from '../notificationRecap.js';

/** First line of the report with content, compacted for the Inbox; a bare "Summary" heading is skipped. */
export function agentReportRecap(report: string): string | undefined {
    for (const line of report.split(/\r?\n/)) {
        const recap = compactNotificationRecap(line);
        if (recap) return recap;
    }
    return undefined;
}
