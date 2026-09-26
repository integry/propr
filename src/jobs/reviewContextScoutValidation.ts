import { promises as fs } from 'node:fs';
import path from 'node:path';

const MAX_REFERENCES = 12;
const MAX_LINES_PER_REFERENCE = 200;
const MAX_FILE_BYTES = 250_000;
const MAX_CONTEXT_CHARS = 60_000;

export interface ReviewContextReference {
    path: string;
    startLine: number;
    endLine: number;
    relationship: string;
    reason: string;
}
interface ScoutResponse {
    references: ReviewContextReference[];
}

function parseScoutResponse(response: string): ScoutResponse {
    const trimmed = response.trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/, '');
    const parsed = JSON.parse(trimmed) as { references?: unknown };
    if (!Array.isArray(parsed.references)) {
        throw new Error('Context scout response did not contain a references array');
    }
    return { references: parsed.references as ReviewContextReference[] };
}

function isSafeRelativePath(filePath: string): boolean {
    if (!filePath || path.isAbsolute(filePath) || filePath.includes('\0')) return false;
    const normalized = path.posix.normalize(filePath.replaceAll('\\', '/'));
    return normalized !== '..' && !normalized.startsWith('../') && normalized !== '.git' && !normalized.startsWith('.git/');
}

function normalizeReferenceInput(
    reference: ReviewContextReference,
    changedPaths: Set<string>
): { normalizedPath: string; startLine: number; endLine: number } | null {
    if (!reference || typeof reference.path !== 'string' || !isSafeRelativePath(reference.path)) return null;
    const normalizedPath = path.posix.normalize(reference.path.replaceAll('\\', '/'));
    if (changedPaths.has(normalizedPath)) return null;
    if (!Number.isInteger(reference.startLine) || !Number.isInteger(reference.endLine)) return null;
    if (reference.startLine < 1 || reference.endLine < reference.startLine) return null;
    return {
        normalizedPath,
        startLine: reference.startLine,
        endLine: Math.min(reference.endLine, reference.startLine + MAX_LINES_PER_REFERENCE - 1),
    };
}

async function extractReference(
    rootPath: string,
    rootRealPath: string,
    reference: ReviewContextReference,
    changedPaths: Set<string>
): Promise<string | null> {
    const normalized = normalizeReferenceInput(reference, changedPaths);
    if (!normalized) return null;
    const { normalizedPath, startLine, endLine: requestedEndLine } = normalized;
    const absolutePath = path.resolve(rootPath, normalizedPath);
    const realPath = await fs.realpath(absolutePath).catch(() => null);
    if (!realPath || (realPath !== rootRealPath && !realPath.startsWith(`${rootRealPath}${path.sep}`))) return null;

    const stats = await fs.stat(realPath).catch(() => null);
    if (!stats?.isFile() || stats.size > MAX_FILE_BYTES) return null;
    const content = await fs.readFile(realPath, 'utf8').catch(() => null);
    if (content === null || content.includes('\0')) return null;

    const lines = content.split('\n');
    if (startLine > lines.length) return null;
    const endLine = Math.min(requestedEndLine, lines.length);
    const excerpt = lines
        .slice(startLine - 1, endLine)
        .map((line, index) => `${startLine + index}: ${line}`)
        .join('\n');
    const relationship = typeof reference.relationship === 'string' ? reference.relationship.trim().slice(0, 120) : 'related code';
    const reason = typeof reference.reason === 'string' ? reference.reason.trim().slice(0, 500) : '';
    return `### ${normalizedPath}:${startLine}-${endLine}\nRelationship lead: ${relationship || 'related code'}${reason ? `\nScout rationale: ${reason}` : ''}\n\n\`\`\`\n${excerpt}\n\`\`\``;
}

export async function validateAndExtractScoutContext(
    worktreePath: string,
    changedFiles: Iterable<string>,
    response: string
): Promise<string> {
    const parsed = parseScoutResponse(response);
    const rootRealPath = await fs.realpath(worktreePath);
    const changedPaths = new Set([...changedFiles].map(filePath => path.posix.normalize(filePath.replaceAll('\\', '/'))));
    const sections: string[] = [];
    let totalLength = 0;

    for (const reference of parsed.references.slice(0, MAX_REFERENCES)) {
        const section = await extractReference(worktreePath, rootRealPath, reference, changedPaths);
        if (!section || totalLength + section.length > MAX_CONTEXT_CHARS) continue;
        sections.push(section);
        totalLength += section.length;
    }
    return sections.join('\n\n');
}
