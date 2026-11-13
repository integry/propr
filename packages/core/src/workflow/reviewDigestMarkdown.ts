/**
 * Markdown for the review digest section of pull request descriptions and
 * completion comments. Bounded, and every repository- or agent-controlled
 * string is a code span: paths, dependency names and validation commands.
 */
import { describeRepositoryValidationStatus } from './repositoryValidationResult.js';
import { REVIEW_RISK_TIERS, type ReviewDigest, type ReviewDigestFile, type ReviewRiskReason, type ReviewRiskTier } from './reviewDigest.js';
import { redactSecrets } from '../utils/secretRedaction.js';

/** Files listed across all tiers, like the `files_changed` section. */
export const REVIEW_DIGEST_MAX_LISTED_FILES = 50;
const MAX_LISTED_DEPENDENCIES = 30;
const MAX_LISTED_COMMANDS = 20;
const MAX_COMMAND_LABEL_LENGTH = 120;

const TIER_LABEL: Record<ReviewRiskTier, string> = { high: 'High risk', normal: 'Normal risk', low: 'Low risk' };
const REASON_LABEL: Record<ReviewRiskReason, string> = {
    review_risk_paths: 'matches `review.risk_paths`',
    ci_workflow: 'CI or workflow file',
    propr_configuration: 'ProPR configuration',
    agent_configuration: 'agent configuration',
    lockfile: 'lockfile',
    dependency_manifest: 'dependency manifest',
    database_migration: 'database migration',
    auth_path: 'auth-looking path',
    payment_path: 'payment-looking path',
    documentation: 'documentation',
    test: 'test',
};

/** A CommonMark code span that holds any text: the fence is longer than every backtick run inside. */
function codeSpan(text: string): string {
    // Line breaks would end the list item; other control characters are invisible.
    // eslint-disable-next-line no-control-regex
    const clean = text.replace(/[\r\n\t]+/g, ' ').replace(/[\u0000-\u001f\u007f]/g, '');
    const longest = Math.max(0, ...(clean.match(/`+/g) ?? []).map(run => run.length));
    const fence = '`'.repeat(longest + 1);
    const pad = /^[` ]|[` ]$/.test(clean) ? ' ' : '';
    return `${fence}${pad}${clean}${pad}${fence}`;
}

function plural(value: number, noun: string): string {
    return `${value.toLocaleString('en-US')} ${noun}${value === 1 ? '' : 's'}`;
}

function lineCounts(file: Pick<ReviewDigestFile, 'linesAdded' | 'linesRemoved'>): string {
    return `+${file.linesAdded.toLocaleString('en-US')}/−${file.linesRemoved.toLocaleString('en-US')}`;
}

function fileLine(file: ReviewDigestFile, tier: ReviewRiskTier): string {
    const status = file.status === 'modified' ? '' : `${file.status}, `;
    // Low-risk reasons restate the tier; high-risk reasons say why to look.
    const reason = tier === 'high' && file.reason ? `: ${REASON_LABEL[file.reason]}` : '';
    return `  - ${codeSpan(file.path)} (${status}${lineCounts(file)})${reason}`;
}

function riskSection(digest: ReviewDigest): string[] {
    const lines = ['**Risk-tiered paths**', ''];
    let budget = REVIEW_DIGEST_MAX_LISTED_FILES;
    for (const tier of REVIEW_RISK_TIERS) {
        const { count, files } = digest.tiers[tier];
        if (!count) {
            lines.push(`- **${TIER_LABEL[tier]}**: none`);
            continue;
        }
        lines.push(`- **${TIER_LABEL[tier]}** (${plural(count, 'file')})`);
        const listed = files.slice(0, budget);
        budget -= listed.length;
        lines.push(...listed.map(file => fileLine(file, tier)));
        if (count > listed.length) lines.push(`  - …and ${(count - listed.length).toLocaleString('en-US')} more`);
    }
    const { count, entries } = digest.newDependencies;
    if (count) {
        const listed = entries.slice(0, MAX_LISTED_DEPENDENCIES).map(entry => `${codeSpan(entry.name)} in ${codeSpan(entry.manifest)}`);
        const more = count > listed.length ? `, …and ${(count - listed.length).toLocaleString('en-US')} more` : '';
        lines.push('', `**New dependencies** (${count.toLocaleString('en-US')}): ${listed.join(', ')}${more}`);
    }
    return lines;
}

function commandLabel(command: string): string {
    return command.length <= MAX_COMMAND_LABEL_LENGTH ? command : `${command.slice(0, MAX_COMMAND_LABEL_LENGTH - 1).trimEnd()}…`;
}

function validationSection(digest: ReviewDigest): string[] {
    const validation = digest.validation;
    if (!validation?.commands.length) return ['**Validation evidence**', '', '- No repository validation commands ran.'];
    const listed = validation.commands.slice(0, MAX_LISTED_COMMANDS)
        .map(entry => `- [${entry.index + 1}] ${codeSpan(commandLabel(entry.command))}: ${describeRepositoryValidationStatus(entry)}`);
    const more = validation.commands.length - listed.length;
    return [`**Validation evidence** (${validation.overall})`, '', ...listed, ...(more > 0 ? [`- …and ${more} more`] : [])];
}

/** The digest section, ending in a blank line like the other completion parts; empty without a digest. */
export function renderReviewDigest(digest: ReviewDigest | null | undefined): string {
    if (!digest) return '';
    const { files, linesAdded, linesRemoved } = digest.size;
    const lines = [
        '### Review digest',
        '',
        ...riskSection(digest),
        '',
        ...validationSection(digest),
        '',
        `**Diff size:** ${plural(files, 'file')} changed, ${lineCounts({ linesAdded, linesRemoved })} lines`,
    ];
    return `${redactSecrets(lines.join('\n'))}\n\n`;
}

/** One line for the timeline event. */
export function summarizeReviewDigest(digest: ReviewDigest): string {
    const tiers = REVIEW_RISK_TIERS.map(tier => `${digest.tiers[tier].count} ${tier}`).join(', ');
    const dependencies = digest.newDependencies.count ? `; ${plural(digest.newDependencies.count, 'new dependency').replace(/dependencys$/, 'dependencies')}` : '';
    const validation = digest.validation ? `; validation ${digest.validation.overall}` : '';
    return `Review digest: ${plural(digest.size.files, 'file')} (${lineCounts(digest.size)}): ${tiers} risk${dependencies}${validation}`;
}
