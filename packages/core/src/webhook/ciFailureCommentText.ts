/**
 * The text of a CI-failure comment: its title, instruction and each check's
 * details and evidence, with a dependency line in the section of a failed job
 * that needs other failed jobs of the same workflow run.
 */
import type { CiFailureAnnotation, CiFailureEvidence, CiFailureFollowupRequest } from './ciFailureFollowup.js';

const MAX_EXCERPT_LENGTH = 1800;

export const DEPENDENCY_LINE_PREFIX = 'Depends on the failed job(s) above: ';
const DEPENDENCY_LINE_SUFFIX = '. It may have failed only because they did; check them first.';

export interface ReportedCheck {
    evidence: CiFailureEvidence;
    excerpt: string | undefined;
    /** The failed jobs of the same run this job needs, as reported; no line when empty. */
    dependsOn?: readonly string[];
}

/** The line a failed job's section carries when it needs jobs that failed in the same run. */
export function buildDependencyLine(dependsOn: readonly string[]): string {
    return `${DEPENDENCY_LINE_PREFIX}${dependsOn.map(formatJobName).join(', ')}${DEPENDENCY_LINE_SUFFIX}`;
}

/** Whether a section line written by `buildDependencyLine` names the job `name`. */
export function dependencyLineNames(line: string, name: string): boolean {
    if (!line.startsWith(DEPENDENCY_LINE_PREFIX) || !line.endsWith(DEPENDENCY_LINE_SUFFIX)) return false;
    const names = line.slice(DEPENDENCY_LINE_PREFIX.length, line.length - DEPENDENCY_LINE_SUFFIX.length);
    const token = formatJobName(name);
    return `, ${names}, `.includes(`, ${token}, `);
}

function formatJobName(name: string): string {
    return `\`${escapeInlineCode(name)}\``;
}

/** Title, instruction and each check's section; the commit follows the first check's result. */
export function buildCommentContent(request: CiFailureFollowupRequest, checks: ReportedCheck[]): string[] {
    const { sha } = request.evidence;
    const commitUrl = `https://github.com/${encodeURIComponent(request.owner)}/${encodeURIComponent(request.repo)}/commit/${encodeURIComponent(sha)}`;
    const commitLine = `- Commit: [\`${sha.slice(0, 12)}\`](${commitUrl}) (\`${escapeInlineCode(sha)}\`)`;
    const [first, ...others] = checks;
    const [checkLine, resultLine, ...evidenceLines] = buildCheckSection(first);
    return [
        `CI failed: ${checks.map(check => checkTitle(check.evidence)).join(', ')}`,
        '',
        checks.length === 1 ? 'Please investigate and fix this CI failure.' : 'Please investigate and fix these CI failures.',
        '',
        checkLine,
        resultLine,
        commitLine,
        ...evidenceLines,
        ...others.flatMap(check => ['', '---', '', ...buildCheckSection(check)]),
    ];
}

export function checkTitle(evidence: Pick<CiFailureEvidence, 'name'>): string {
    return `**${escapeInlineMarkdown(evidence.name)}**`;
}

/**
 * One check's details, dependency line and evidence; the commit is shared by
 * every check of a comment and follows the first check's result.
 */
export function buildCheckSection({ evidence, excerpt: failureExcerpt, dependsOn = [] }: ReportedCheck): string[] {
    const excerpt = truncate(failureExcerpt?.trim() || evidence.fallbackExcerpt?.trim() || 'No failure output was provided by the CI service.');
    return [
        `- Check: \`${escapeInlineCode(evidence.name)}\``,
        `- Result: \`${escapeInlineCode(evidence.state)}\``,
        `- Run: [View CI failure](${evidence.url})`,
        '',
        ...(dependsOn.length > 0 ? [buildDependencyLine(dependsOn), ''] : []),
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
