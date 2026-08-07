import type { AIReviewComment } from './reviewCommentGatherer.js';

export function formatReviewCommentsSection(reviewComments: AIReviewComment[]): string {
    if (reviewComments.length === 0) return '';

    let section = `**AI Review Comments (unprocessed — please address these findings):**\n\n`;
    for (const comment of reviewComments) {
        section += `---\n**Review by:** @${comment.author} (Comment ID: ${comment.id})\n`;
        section += `${comment.body}\n---\n\n`;
    }
    return section;
}
