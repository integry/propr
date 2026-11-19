/**
 * The text of a CI-failure comment: its title, instruction and each check's
 * details and evidence, and the one-line mention of a failed aggregate job
 * folded under the needed jobs that made it fail.
 */
import type { AggregateFold } from './ciFailureAggregateFold.js';
import type { CiFailureAnnotation, CiFailureEvidence, CiFailureFollowupRequest } from './ciFailureFollowup.js';

const MAX_EXCERPT_LENGTH = 1800;

export interface ReportedCheck {
    evidence: CiFailureEvidence;
    excerpt: string | undefined;
}

/** The aggregate's one mention: a consequence of the failed jobs it needs, with no evidence of its own. */
export function buildAggregateConsequenceLine(fold: AggregateFold): string {
    const causes = fold.causes.map(cause => `\`${escapeInlineCode(cause.name)}\``).join(', ');
    const subject = fold.causes.length === 1 ? 'job' : 'jobs';
    return `Also failed: **${escapeInlineMarkdown(fold.aggregate)}**, which only reports the result of the failed ${subject} it needs (${causes}); it has no failure of its own.`;
}

/** Title, instruction and each check's section; the commit follows the first check's result. */
export function buildCommentContent(request: CiFailureFollowupRequest, checks: ReportedCheck[]): string[] {
    const { sha } = request.evidence;
    const commitUrl = `https://github.com/${encodeURIComponent(request.owner)}/${encodeURIComponent(request.repo)}/commit/${encodeURIComponent(sha)}`;
    const commitLine = `- Commit: [\`${sha.slice(0, 12)}\`](${commitUrl}) (\`${escapeInlineCode(sha)}\`)`;
    const [first, ...others] = checks;
    const [checkLine, resultLine, ...evidenceLines] = buildCheckSection(first.evidence, first.excerpt);
    return [
        `CI failed: ${checks.map(check => checkTitle(check.evidence)).join(', ')}`,
        '',
        checks.length === 1 ? 'Please investigate and fix this CI failure.' : 'Please investigate and fix these CI failures.',
        '',
        checkLine,
        resultLine,
        commitLine,
        ...evidenceLines,
        ...others.flatMap(check => ['', '---', '', ...buildCheckSection(check.evidence, check.excerpt)]),
    ];
}

export function checkTitle(evidence: CiFailureEvidence): string {
    return `**${escapeInlineMarkdown(evidence.name)}**`;
}

/** One check's details and evidence; the commit is shared by every check of a comment. */
export function buildCheckSection(evidence: CiFailureEvidence, failureExcerpt: string | undefined): string[] {
    const excerpt = truncate(failureExcerpt?.trim() || evidence.fallbackExcerpt?.trim() || 'No failure output was provided by the CI service.');
    return [
        `- Check: \`${escapeInlineCode(evidence.name)}\``,
        `- Result: \`${escapeInlineCode(evidence.state)}\``,
        `- Run: [View CI failure](${evidence.url})`,
        '',
        '**Failure evidence**',
        ...excerpt.split('\n').map(line => `> ${line || ' '}`),
    ];
}

export function buildAnnotationExcerpt(annotations: CiFailureAnnotation[]): string | undefined {
    const usefulAnnotations = [...annotations]
        .sort((left, right) => annotationPriority(left) - annotationPriority(right))
        .filter(annotation => annotation.message || annotation.title || annotation.raw_details)
        .slice(0, 3);
    if (usefulAnnotations.length === 0) return undefined;

    return truncate(usefulAnnotations.map(annotation => {
        const location = annotation.path
            ? `${annotation.path}${formatAnnotationLines(annotation.start_line, annotation.end_line)}`
            : '';
        return joinUsefulText([
            joinUsefulText([location, annotation.title], ' — '),
            annotation.message,
            annotation.raw_details,
        ]);
    }).filter(Boolean).join('\n\n'));
}

function annotationPriority(annotation: CiFailureAnnotation): number {
    if (annotation.annotation_level === 'failure') return 0;
    if (annotation.annotation_level === 'warning') return 1;
    return 2;
}

function formatAnnotationLines(startLine?: number | null, endLine?: number | null): string {
    if (startLine == null) return '';
    return endLine != null && endLine !== startLine ? `:${startLine}-${endLine}` : `:${startLine}`;
}

export function joinUsefulText(values: Array<string | null | undefined>, separator = '\n'): string {
    return values.map(value => value?.trim()).filter((value): value is string => Boolean(value)).join(separator);
}

function truncate(value: string): string {
    if (value.length <= MAX_EXCERPT_LENGTH) return value;
    return `${value.slice(0, MAX_EXCERPT_LENGTH - 1).trimEnd()}…`;
}

function escapeInlineCode(value: string): string {
    return value.replace(/([\\`])/gu, '\\$1');
}

function escapeInlineMarkdown(value: string): string {
    return value.replace(/([\\*_`[\]])/gu, '\\$1');
}
