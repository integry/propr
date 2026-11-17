/**
 * One CI-failure comment per pull request head commit. Every failing check of
 * that commit is an entry of the same comment, so a burst of failing jobs
 * starts one follow-up instead of one per job. Entries carry their identity in
 * a hidden marker so a later failure can be merged into the posted comment.
 */
import { createHash } from 'node:crypto';

/** Most entries one comment lists; later failures of the head are counted only. */
export const MAX_CI_FAILURE_ENTRIES = 10;

const ENTRY_MARKER_RE = /<!-- propr:ci-failure-entry data="([A-Za-z0-9_-]+)" -->/g;
const ENTRY_MARKER_STRIP_RE = /\n?<!-- propr:ci-failure-entry data="[A-Za-z0-9_-]+" -->/g;
const OMITTED_MARKER_RE = /<!-- propr:ci-failure-omitted count="(\d+)" -->/;

export interface CiFailureEntry {
    name: string;
    state: string;
    url: string;
    source: string;
    excerpt: string;
}

/** Key of the single CI-failure comment of one pull request head. */
export function buildCiFailureHeadKey(parts: { owner: string; repo: string; prNumber: number; sha: string }): string {
    const identity = ['head', parts.owner.toLowerCase(), parts.repo.toLowerCase(), parts.prNumber, parts.sha.toLowerCase()].join('\0');
    return createHash('sha256').update(identity).digest('hex');
}

// Matrix and shard designators: `Shard 1/4`, `(1, 4)`, `(ubuntu-latest)`, a trailing `2/4`.
const SHARD_DESIGNATOR_RE = /\s*(?:\bshard\s*\d+(?:\s*\/\s*\d+)?|\([^)]*\)|\b\d+\s*\/\s*\d+)\s*$/i;

function normalizeCheckName(name: string): { base: string; sharded: boolean } {
    let base = name.trim().toLowerCase();
    let sharded = false;
    for (let guard = 0; guard < 3 && SHARD_DESIGNATOR_RE.test(base); guard++) {
        base = base.replace(SHARD_DESIGNATOR_RE, '');
        sharded = true;
    }
    // "Run Full Test Suite" aggregates "Full Test Suite Shard 1/4"; a leading verb is not part of the identity.
    base = base.replace(/^(?:run|check|verify|test)\s+/, '').replace(/\s+/g, ' ').trim();
    return { base, sharded };
}

/** True when `aggregateName` is the aggregate job over the shard `shardName`. */
export function isAggregateOfShard(aggregateName: string, shardName: string): boolean {
    const aggregate = normalizeCheckName(aggregateName);
    const shard = normalizeCheckName(shardName);
    return !aggregate.sharded && shard.sharded && aggregate.base.length > 0 && aggregate.base === shard.base;
}

/** Drop every aggregate entry whose own shard is listed: the shard is the actionable failure. */
export function dropAggregatesWithListedShards<T extends { name: string }>(entries: readonly T[]): T[] {
    return entries.filter(entry => !entries.some(other => other !== entry && isAggregateOfShard(entry.name, other.name)));
}

function encodeEntry(entry: CiFailureEntry): string {
    const { name, state, url, source } = entry;
    return Buffer.from(JSON.stringify({ name, state, url, source }), 'utf8').toString('base64url');
}

function decodeEntry(data: string): Omit<CiFailureEntry, 'excerpt'> | null {
    try {
        const parsed = JSON.parse(Buffer.from(data, 'base64url').toString('utf8')) as Record<string, unknown>;
        const { name, state, url, source } = parsed;
        if ([name, state, url, source].every(value => typeof value === 'string')) {
            return { name, state, url, source } as Omit<CiFailureEntry, 'excerpt'>;
        }
    } catch {
        // A damaged marker is not an entry.
    }
    return null;
}

function escapeInlineCode(value: string): string {
    return value.replace(/([\\`])/gu, '\\$1');
}

function escapeInlineMarkdown(value: string): string {
    return value.replace(/([\\*_`[\]])/gu, '\\$1');
}

/** Entries of a posted CI-failure comment, with their quoted evidence. */
export function parseCiFailureEntries(body: string): CiFailureEntry[] {
    const markers = [...body.matchAll(ENTRY_MARKER_RE)];
    return markers.flatMap((marker, index) => {
        const entry = decodeEntry(marker[1]);
        if (!entry) return [];
        const segment = body.slice(marker.index! + marker[0].length, markers[index + 1]?.index ?? body.length);
        const quoted: string[] = [];
        let inQuote = false;
        for (const line of segment.split('\n')) {
            if (line.startsWith('>')) {
                inQuote = true;
                quoted.push(line.replace(/^> ?/, '').replace(/^ $/, ''));
            } else if (inQuote) {
                break;
            }
        }
        return [{ ...entry, excerpt: quoted.join('\n').trim() }];
    });
}

/** Failures beyond the listed entries, recorded on the comment. */
export function parseOmittedCiFailureCount(body: string): number {
    return Number(body.match(OMITTED_MARKER_RE)?.[1] ?? 0);
}

/**
 * Merge an incoming failure into the listed entries. Null when it changes
 * nothing: the same source is already listed, or it is an aggregate whose
 * shard is listed.
 */
export function mergeCiFailureEntry(
    existing: readonly CiFailureEntry[],
    incoming: CiFailureEntry,
): CiFailureEntry[] | null {
    if (existing.some(entry => entry.source.toLowerCase() === incoming.source.toLowerCase())) return null;
    if (existing.some(entry => isAggregateOfShard(incoming.name, entry.name))) return null;
    return dropAggregatesWithListedShards([...existing, incoming]);
}

export function renderCiFailureHeadComment(options: {
    owner: string;
    repo: string;
    sha: string;
    entries: readonly CiFailureEntry[];
    marker: string;
    omittedCount?: number;
}): string {
    const listed = options.entries.slice(0, MAX_CI_FAILURE_ENTRIES);
    const omitted = (options.omittedCount ?? 0) + Math.max(0, options.entries.length - listed.length);
    const commitUrl = `https://github.com/${options.owner}/${options.repo}/commit/${options.sha}`;
    const shortSha = options.sha.slice(0, 12);
    const title = listed.length === 1
        ? `CI failed: **${escapeInlineMarkdown(listed[0].name)}**`
        : `CI failed: **${listed.length} checks**`;
    const lines = [
        title,
        '',
        listed.length === 1 ? 'Please investigate and fix this CI failure.' : 'Please investigate and fix these CI failures.',
        '',
        `- Commit: [\`${shortSha}\`](${commitUrl}) (\`${escapeInlineCode(options.sha)}\`)`,
    ];
    for (const entry of listed) {
        lines.push(
            '',
            `<!-- propr:ci-failure-entry data="${encodeEntry(entry)}" -->`,
            `**Check:** \`${escapeInlineCode(entry.name)}\` — Result: \`${escapeInlineCode(entry.state)}\` — [View CI failure](${entry.url})`,
            '',
            ...(entry.excerpt || 'No failure output was provided by the CI service.').split('\n').map(line => `> ${line || ' '}`),
        );
    }
    if (omitted > 0) {
        lines.push('', `_${omitted} more failing check${omitted === 1 ? '' : 's'} on this commit are not listed._`, `<!-- propr:ci-failure-omitted count="${omitted}" -->`);
    }
    lines.push('', options.marker);
    return lines.join('\n');
}

/** Remove the per-entry markers before the comment reaches an agent. */
export function stripCiFailureEntryMarkers(body: string): string {
    return body.replace(ENTRY_MARKER_STRIP_RE, '').replace(/\n?<!-- propr:ci-failure-omitted count="\d+" -->/g, '');
}
