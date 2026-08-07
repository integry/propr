/**
 * Parsing and rendering for the structured review contract.
 *
 * Reviewing agents return a machine-oriented record with explicit policy
 * fields. GitHub comments use a smaller public contract whose section and F#
 * heading carry those policy meanings. Both forms remain parseable so /fix can
 * consume new comments while older comments continue to work.
 */

export type ReviewOutputStatus = 'valid_with_blockers' | 'valid_clean' | 'invalid';

export interface ActionableFinding {
    id: string;
    title: string;
    violatedRequirement: string;
    evidence: string;
    introducedByPR: true;
    introducedByPRExplanation: string;
    requiredForMerge: true;
    minimumCorrection: string;
}

export interface ReviewSuggestion {
    id: string;
    title: string;
}

export interface StructuredReviewResult {
    status: ReviewOutputStatus;
    actionableFindings: ActionableFinding[];
    suggestions: ReviewSuggestion[];
    score: number | null;
}

export const MERGE_BLOCKERS_INTRODUCTION = 'Every finding below was introduced by this PR and must be resolved before merging.';
export const SUGGESTIONS_INTRODUCTION = 'These are optional follow-ups and are not sent to `/fix`.';

const MACHINE_SECTION_HEADINGS = [
    'Overall Evaluation',
    'Actionable Findings',
    'Suggestions and Follow-ups',
    'Score',
] as const;

const PUBLIC_SECTION_HEADINGS = [
    'Overall Evaluation',
    'Merge blockers',
    'Suggestions',
    'Score',
] as const;

/** Error reviews are diagnostic comments and must never satisfy the review contract. */
const ERROR_REVIEW_MARKER_RE = /<!--\s*propr:ai-review\b[^>]*\berror\s*=\s*["']true["'][^>]*-->/i;

/** The only level-two heading added outside the model's review response. */
const REVIEW_TITLE_WRAPPER_RE = /^##[ \t]+🔍[ \t]+AI Code Review[ \t]+—[ \t]+[^\r\n]+[ \t]*\r?\n(?:\r?\n)?/;

function invalidReview(): StructuredReviewResult {
    return { status: 'invalid', actionableFindings: [], suggestions: [], score: null };
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractMarkdownSection(body: string, heading: string): string {
    const headingRe = new RegExp(`^##[ \\t]+${escapeRegExp(heading)}(?:[ \\t]+.*)?$`, 'im');
    const match = headingRe.exec(body);
    if (!match) return '';
    const contentStart = match.index + match[0].length;
    const rest = body.slice(contentStart);
    const nextHeading = /^##\s+/m.exec(rest);
    return (nextHeading ? rest.slice(0, nextHeading.index) : rest).trim();
}

function extractRecordFields(block: string): Map<string, string> {
    const fields = new Map<string, string>();
    for (const line of block.split('\n')) {
        const bold = line.match(/^[-*]\s+\*\*([^*]+)\*\*\s*(.*)$/);
        const plain = line.match(/^[-*]\s+([A-Za-z][A-Za-z0-9 -]*):\s*(.*)$/);
        const rawKey = bold?.[1] ?? plain?.[1];
        if (!rawKey) continue;
        const key = rawKey.replace(/:$/, '').replace(/[\s-]/g, '').toLowerCase();
        const value = (bold?.[2] ?? plain?.[2] ?? '').replace(/^:\s*/, '').trim();
        fields.set(key, value);
    }
    return fields;
}

interface MarkdownRecord {
    id: string;
    title: string;
    body: string;
}

function extractMarkdownRecords(section: string, prefix: 'F' | 'S'): MarkdownRecord[] {
    const headingRe = new RegExp(`^###[ \\t]+(${prefix}\\d+)[ \\t]*(?::|[-—])[ \\t]*(.+)$`, 'gim');
    const matches = [...section.matchAll(headingRe)];
    return matches.map((match, index) => ({
        id: match[1].toUpperCase(),
        title: match[2].trim(),
        body: section.slice(
            (match.index ?? 0) + match[0].length,
            matches[index + 1]?.index ?? section.length,
        ).trim(),
    }));
}

function hasExactlyOneSection(body: string, heading: string): boolean {
    const headingRe = new RegExp(`^##[ \\t]+${escapeRegExp(heading)}[ \\t]*$`, 'gim');
    return [...body.matchAll(headingRe)].length === 1;
}

function hasExpectedSections(body: string, headings: readonly string[]): boolean {
    const sectionMatches = headings.map(heading => {
        const headingRe = new RegExp(`^##[ \\t]+${escapeRegExp(heading)}[ \\t]*$`, 'im');
        return headingRe.exec(body);
    });
    const actualHeadings = [...body.matchAll(/^##[ \t]+(.+?)[ \t]*$/gm)]
        .map(match => match[1].trim());

    return sectionMatches.every((match): match is RegExpExecArray => match !== null)
        && sectionMatches.every((match, index) => index === 0 || match!.index > sectionMatches[index - 1]!.index)
        && headings.every(heading => hasExactlyOneSection(body, heading))
        && actualHeadings.length === headings.length
        && actualHeadings.every((heading, index) => heading === headings[index]);
}

function hasSequentialRecordHeadings(section: string, records: MarkdownRecord[], prefix: 'F' | 'S'): boolean {
    const allRecordHeadings = [
        ...section.matchAll(new RegExp(`^###[ \\t]+${prefix}\\d+\\b.*$`, 'gim')),
    ];
    return allRecordHeadings.length === records.length
        && records.every((record, index) => record.id === `${prefix}${index + 1}`);
}

function parseMachineActionableRecords(section: string): ActionableFinding[] | null {
    const records = extractMarkdownRecords(section, 'F');
    if (records.length === 0 || !hasSequentialRecordHeadings(section, records, 'F')) return null;

    const findings: ActionableFinding[] = [];
    for (const record of records) {
        const fields = extractRecordFields(record.body);
        const violatedRequirement = fields.get('violatedrequirement') ?? '';
        const evidence = fields.get('evidence') ?? '';
        const introducedByPR = fields.get('introducedbypr') ?? '';
        const requiredForMerge = fields.get('requiredformerge') ?? '';
        const minimumCorrection = fields.get('minimumcorrection') ?? '';
        const introducedByPRExplanation = introducedByPR.replace(/^true\b\s*(?:[-—:]\s*)?/i, '').trim();
        if (!violatedRequirement || !evidence || !introducedByPRExplanation || !minimumCorrection) return null;
        if (!/^true\b/i.test(introducedByPR) || !/^true\b/i.test(requiredForMerge)) return null;
        findings.push({
            id: record.id,
            title: record.title,
            violatedRequirement,
            evidence,
            introducedByPR: true,
            introducedByPRExplanation,
            requiredForMerge: true,
            minimumCorrection,
        });
    }
    return findings;
}

function parsePublicActionableRecords(section: string): ActionableFinding[] | null {
    if (!section.startsWith(`${MERGE_BLOCKERS_INTRODUCTION}\n`)) return null;
    const recordsSection = section.slice(MERGE_BLOCKERS_INTRODUCTION.length).trim();
    if (recordsSection === 'No merge blockers.') return [];
    if (!/^### F1\b/.test(recordsSection)) return null;

    const records = extractMarkdownRecords(recordsSection, 'F');
    if (records.length === 0 || !hasSequentialRecordHeadings(recordsSection, records, 'F')) return null;

    const findings: ActionableFinding[] = [];
    for (const record of records) {
        const fields = extractRecordFields(record.body);
        const violatedRequirement = fields.get('requiredbehavior') ?? '';
        const evidence = fields.get('evidence') ?? '';
        const minimumCorrection = fields.get('minimumfix') ?? '';
        if (fields.size !== 3 || !violatedRequirement || !evidence || !minimumCorrection) return null;
        findings.push({
            id: record.id,
            title: record.title,
            violatedRequirement,
            evidence,
            introducedByPR: true,
            introducedByPRExplanation: 'Classified as introduced by this PR in the Merge blockers section.',
            requiredForMerge: true,
            minimumCorrection,
        });
    }
    return findings;
}

function parseSuggestionRecords(section: string): ReviewSuggestion[] | null {
    if (section.trim() === 'No suggestions.') return [];

    const records = extractMarkdownRecords(section, 'S');
    if (
        records.length === 0
        || !hasSequentialRecordHeadings(section, records, 'S')
        || records.some(record => record.body !== '')
    ) return null;
    return records.map(record => ({ id: record.id, title: record.title }));
}

function parsePublicSuggestionRecords(section: string): ReviewSuggestion[] | null {
    if (!section.startsWith(`${SUGGESTIONS_INTRODUCTION}\n`)) return null;
    const recordsSection = section.slice(SUGGESTIONS_INTRODUCTION.length).trim();
    if (recordsSection !== 'No suggestions.' && !/^### S1\b/.test(recordsSection)) return null;
    return parseSuggestionRecords(recordsSection);
}

interface ReviewContract {
    headings: readonly [string, string, string, string];
    cleanSentinel: string;
    parseFindings(section: string): ActionableFinding[] | null;
    parseSuggestions(section: string): ReviewSuggestion[] | null;
}

const MACHINE_CONTRACT: ReviewContract = {
    headings: MACHINE_SECTION_HEADINGS,
    cleanSentinel: 'No actionable findings.',
    parseFindings: parseMachineActionableRecords,
    parseSuggestions: parseSuggestionRecords,
};

const PUBLIC_CONTRACT: ReviewContract = {
    headings: PUBLIC_SECTION_HEADINGS,
    cleanSentinel: '',
    parseFindings: parsePublicActionableRecords,
    parseSuggestions: parsePublicSuggestionRecords,
};

function parseContract(body: string, contract: ReviewContract): StructuredReviewResult {
    if (!hasExpectedSections(body, contract.headings)) return invalidReview();

    const [overallHeading, findingsHeading, suggestionsHeading, scoreHeading] = contract.headings;
    const overallSection = extractMarkdownSection(body, overallHeading);
    const findingsSection = extractMarkdownSection(body, findingsHeading);
    const suggestionSection = extractMarkdownSection(body, suggestionsHeading);
    const scoreSection = extractMarkdownSection(body, scoreHeading);
    const scoreMatches = [...scoreSection.matchAll(/^Score:[ \t]*(\d{1,2})[ \t]*\/[ \t]*10[ \t]*$/gm)];
    const score = scoreMatches.length === 1 ? Number.parseInt(scoreMatches[0][1], 10) : null;
    const suggestions = contract.parseSuggestions(suggestionSection);
    if (!overallSection || suggestions === null || score === null || score < 1 || score > 10) {
        return invalidReview();
    }

    if (contract.cleanSentinel && findingsSection.trim() === contract.cleanSentinel) {
        return { status: 'valid_clean', actionableFindings: [], suggestions, score };
    }

    const actionableFindings = contract.parseFindings(findingsSection);
    if (actionableFindings === null) return invalidReview();
    return {
        status: actionableFindings.length === 0 ? 'valid_clean' : 'valid_with_blockers',
        actionableFindings,
        suggestions,
        score: actionableFindings.length > 0 ? Math.min(score, 6) : score,
    };
}

function prepareReviewBody(body: string): string {
    return stripReviewBoilerplate(body).replace(REVIEW_TITLE_WRAPPER_RE, '');
}

/**
 * Parse either the private reviewer contract or the normalized public comment
 * contract. The private form is checked first for backwards compatibility.
 */
export function parseStructuredReview(body: string): StructuredReviewResult {
    if (ERROR_REVIEW_MARKER_RE.test(body)) return invalidReview();
    const cleaned = prepareReviewBody(body);
    const machineResult = parseContract(cleaned, MACHINE_CONTRACT);
    return machineResult.status !== 'invalid'
        ? machineResult
        : parseContract(cleaned, PUBLIC_CONTRACT);
}

/** Parse only blocker records from either supported review representation. */
export function extractActionableFindings(body: string): ActionableFinding[] {
    const machineSection = extractMarkdownSection(body, 'Actionable Findings');
    if (machineSection) return parseMachineActionableRecords(machineSection) ?? [];
    return parsePublicActionableRecords(extractMarkdownSection(body, 'Merge blockers')) ?? [];
}

/** Parse suggestion headings from either supported review representation. */
export function extractReviewSuggestions(body: string): ReviewSuggestion[] {
    const machineSection = extractMarkdownSection(body, 'Suggestions and Follow-ups');
    const section = machineSection
        ? machineSection
        : extractMarkdownSection(body, 'Suggestions').slice(SUGGESTIONS_INTRODUCTION.length).trim();
    return extractMarkdownRecords(section, 'S').map(record => ({
        id: record.id,
        title: record.title,
    }));
}

function formatPublicFindings(findings: ActionableFinding[]): string {
    if (findings.length === 0) return 'No merge blockers.';
    return findings.map(finding => [
        `### ${finding.id}: ${finding.title}`,
        `- **Required behavior:** ${finding.violatedRequirement}`,
        `- **Evidence:** ${finding.evidence}`,
        `- **Minimum fix:** ${finding.minimumCorrection}`,
    ].join('\n')).join('\n\n');
}

function formatPublicSuggestions(suggestions: ReviewSuggestion[]): string {
    if (suggestions.length === 0) return 'No suggestions.';
    return suggestions.map(suggestion => `### ${suggestion.id}: ${suggestion.title}`).join('\n\n');
}

/**
 * Validate a machine-oriented reviewer response, then render the normalized
 * Markdown that is safe to publish. Invalid responses return null so callers
 * can preserve the original diagnostic output and fail closed downstream.
 */
export function renderPublicReview(
    body: string,
    scoreCap?: { maximum: number; reason: string },
): string | null {
    if (ERROR_REVIEW_MARKER_RE.test(body)) return null;
    const cleaned = prepareReviewBody(body);
    const parsed = parseContract(cleaned, MACHINE_CONTRACT);
    if (parsed.status === 'invalid') return null;

    const overallSection = extractMarkdownSection(cleaned, 'Overall Evaluation');
    const originalScoreSection = extractMarkdownSection(cleaned, 'Score');
    const publishedScore = Math.min(parsed.score ?? 10, scoreCap?.maximum ?? 10);
    const scoreSection = originalScoreSection.replace(
        /^Score:[ \t]*\d{1,2}[ \t]*\/[ \t]*10[ \t]*$/m,
        `Score: ${publishedScore}/10`,
    );
    const originalScore = Number.parseInt(originalScoreSection.match(/^Score:[ \t]*(\d{1,2})[ \t]*\/[ \t]*10[ \t]*$/m)?.[1] ?? '', 10);
    const scoreCapNote = originalScore > publishedScore
        ? `\n\n_${parsed.actionableFindings.length > 0
            ? `Score capped at ${publishedScore} because merge blockers remain.`
            : scoreCap?.reason}_`
        : '';
    return [
        '## Overall Evaluation',
        overallSection,
        '## Merge blockers',
        MERGE_BLOCKERS_INTRODUCTION,
        formatPublicFindings(parsed.actionableFindings),
        '## Suggestions',
        SUGGESTIONS_INTRODUCTION,
        formatPublicSuggestions(parsed.suggestions),
        '## Score',
        `${scoreSection}${scoreCapNote}`,
    ].join('\n\n');
}

/**
 * Strip machine-readable markers and the /fix instruction tip from a review
 * comment body before validating its review sections.
 */
export function stripReviewBoilerplate(body: string): string {
    let cleaned = body.replace(/\n?<!-- propr:ai-review [^>]* -->/g, '');
    cleaned = cleaned.replace(/\n?---\n> 💡 \*\*(?:Tip|Next step):\*\* Comment `\/fix`[^\n]*(?:\n>[^\n]*)*/g, '');
    return cleaned.trimEnd();
}
