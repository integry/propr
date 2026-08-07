const REPOSITORY_SCOUT_SERVER_NAME = 'propr_repository';

export const REPOSITORY_SCOUT_MCP_TOOLS = [
    `mcp__${REPOSITORY_SCOUT_SERVER_NAME}__read_repository_file`,
    `mcp__${REPOSITORY_SCOUT_SERVER_NAME}__glob_repository_paths`,
    `mcp__${REPOSITORY_SCOUT_SERVER_NAME}__search_repository_text`,
] as const;

/**
 * A dependency-free MCP server executed inside the Claude container. Claude's
 * built-in tools stay disabled; this server is the only model-controlled file
 * surface and resolves every requested path against the read-only repository.
 */
export const REPOSITORY_SCOUT_MCP_SERVER_SOURCE = String.raw`
'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const readline = require('node:readline');

const root = fs.realpathSync(process.env.PROPR_SCOUT_REPOSITORY_ROOT);
const maxFilesScanned = 50000;
const maxSearchBytes = 64 * 1024 * 1024;
const maxSearchFileBytes = 1024 * 1024;
const maxReadLines = 800;
const maxOutputChars = 120000;

function isWithinRoot(candidate) {
    return candidate === root || candidate.startsWith(root + path.sep);
}

async function resolveExistingPath(input, expectedType) {
    if (typeof input !== 'string' || input.length === 0 || input.includes('\0')) {
        throw new Error('A non-empty repository path is required.');
    }
    const lexicalPath = path.resolve(root, input);
    if (!isWithinRoot(lexicalPath)) {
        throw new Error('Path is outside the repository.');
    }
    const resolvedPath = await fsp.realpath(lexicalPath);
    if (!isWithinRoot(resolvedPath)) {
        throw new Error('Path resolves outside the repository.');
    }
    const stats = await fsp.stat(resolvedPath);
    if (expectedType === 'file' && !stats.isFile()) {
        throw new Error('Path is not a repository file.');
    }
    if (expectedType === 'directory' && !stats.isDirectory()) {
        throw new Error('Path is not a repository directory.');
    }
    return { resolvedPath, stats };
}

function repositoryRelative(absolutePath) {
    return path.relative(root, absolutePath).split(path.sep).join('/');
}

function boundedInteger(value, fallback, minimum, maximum) {
    if (!Number.isInteger(value)) return fallback;
    return Math.max(minimum, Math.min(maximum, value));
}

async function collectFiles(basePath) {
    const files = [];
    const pending = [basePath];
    let visited = 0;
    while (pending.length > 0) {
        const directory = pending.pop();
        const entries = await fsp.readdir(directory, { withFileTypes: true });
        entries.sort((left, right) => right.name.localeCompare(left.name));
        for (const entry of entries) {
            if (++visited > maxFilesScanned) {
                throw new Error('Repository scan exceeded its file limit; narrow the path or glob.');
            }
            if (entry.name === '.git' || entry.isSymbolicLink()) continue;
            const absolutePath = path.join(directory, entry.name);
            if (entry.isDirectory()) pending.push(absolutePath);
            else if (entry.isFile()) files.push(absolutePath);
        }
    }
    return files;
}

function matchesGlob(relativePath, pattern) {
    if (!pattern) return true;
    if (typeof pattern !== 'string' || pattern.length > 500 || pattern.includes('\0')) {
        throw new Error('Glob must be a string of at most 500 characters.');
    }
    return path.matchesGlob(relativePath, pattern)
        || path.matchesGlob(path.basename(relativePath), pattern);
}

async function readRepositoryFile(args) {
    const { resolvedPath } = await resolveExistingPath(args.path, 'file');
    const content = await fsp.readFile(resolvedPath, 'utf8');
    if (content.includes('\0')) throw new Error('Binary files cannot be read by the scout.');
    const lines = content.split(/\r?\n/);
    const startLine = boundedInteger(args.startLine, 1, 1, Math.max(lines.length, 1));
    const requestedEnd = boundedInteger(args.endLine, startLine + maxReadLines - 1, startLine, lines.length);
    const endLine = Math.min(requestedEnd, startLine + maxReadLines - 1);
    const selected = lines.slice(startLine - 1, endLine).join('\n').slice(0, maxOutputChars);
    return {
        path: repositoryRelative(resolvedPath),
        startLine,
        endLine: Math.min(endLine, startLine + selected.split('\n').length - 1),
        content: selected,
    };
}

async function globRepositoryPaths(args) {
    const pattern = args.pattern;
    matchesGlob('', pattern);
    const { resolvedPath } = await resolveExistingPath(args.path || '.', 'directory');
    const maxResults = boundedInteger(args.maxResults, 200, 1, 500);
    const files = await collectFiles(resolvedPath);
    const matches = [];
    for (const file of files) {
        const relativeToBase = path.relative(resolvedPath, file).split(path.sep).join('/');
        if (!matchesGlob(relativeToBase, pattern)) continue;
        matches.push(repositoryRelative(file));
        if (matches.length >= maxResults) break;
    }
    return { paths: matches, truncated: matches.length >= maxResults };
}

async function searchRepositoryText(args) {
    if (typeof args.query !== 'string' || args.query.length === 0 || args.query.length > 500
        || args.query.includes('\0')) {
        throw new Error('Search query must contain between 1 and 500 characters.');
    }
    const { resolvedPath, stats } = await resolveExistingPath(args.path || '.', undefined);
    const maxResults = boundedInteger(args.maxResults, 100, 1, 200);
    const caseSensitive = args.caseSensitive !== false;
    const query = caseSensitive ? args.query : args.query.toLocaleLowerCase('en-US');
    const candidates = stats.isFile() ? [resolvedPath] : await collectFiles(resolvedPath);
    const matches = [];
    let scannedBytes = 0;
    for (const file of candidates) {
        const relativeToBase = stats.isFile()
            ? path.basename(file)
            : path.relative(resolvedPath, file).split(path.sep).join('/');
        if (!matchesGlob(relativeToBase, args.glob)) continue;
        const fileStats = await fsp.stat(file);
        if (fileStats.size > maxSearchFileBytes) continue;
        scannedBytes += fileStats.size;
        if (scannedBytes > maxSearchBytes) break;
        const content = await fsp.readFile(file, 'utf8');
        if (content.includes('\0')) continue;
        const lines = content.split(/\r?\n/);
        for (let index = 0; index < lines.length; index++) {
            const candidate = caseSensitive ? lines[index] : lines[index].toLocaleLowerCase('en-US');
            if (!candidate.includes(query)) continue;
            matches.push({
                path: repositoryRelative(file),
                line: index + 1,
                text: lines[index].slice(0, 1000),
            });
            if (matches.length >= maxResults) {
                return { matches, truncated: true };
            }
        }
    }
    return { matches, truncated: scannedBytes > maxSearchBytes };
}

const tools = [
    {
        name: 'read_repository_file',
        description: 'Read a line range from a file inside the mounted repository.',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Repository-relative file path.' },
                startLine: { type: 'integer', minimum: 1 },
                endLine: { type: 'integer', minimum: 1 },
            },
            required: ['path'],
            additionalProperties: false,
        },
    },
    {
        name: 'glob_repository_paths',
        description: 'Find file paths by glob inside the mounted repository.',
        inputSchema: {
            type: 'object',
            properties: {
                pattern: { type: 'string' },
                path: { type: 'string', description: 'Optional repository-relative directory.' },
                maxResults: { type: 'integer', minimum: 1, maximum: 500 },
            },
            required: ['pattern'],
            additionalProperties: false,
        },
    },
    {
        name: 'search_repository_text',
        description: 'Search for literal text inside repository files without shell access.',
        inputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string' },
                path: { type: 'string', description: 'Optional repository-relative file or directory.' },
                glob: { type: 'string', description: 'Optional file glob.' },
                caseSensitive: { type: 'boolean', default: true },
                maxResults: { type: 'integer', minimum: 1, maximum: 200 },
            },
            required: ['query'],
            additionalProperties: false,
        },
    },
];

function writeMessage(message) {
    process.stdout.write(JSON.stringify(message) + '\n');
}

async function handleRequest(request) {
    if (request.method === 'initialize') {
        return {
            protocolVersion: request.params && request.params.protocolVersion || '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'propr-repository-scout', version: '1.0.0' },
        };
    }
    if (request.method === 'ping') return {};
    if (request.method === 'tools/list') return { tools };
    if (request.method === 'tools/call') {
        const name = request.params && request.params.name;
        const args = request.params && request.params.arguments || {};
        try {
            let result;
            if (name === 'read_repository_file') result = await readRepositoryFile(args);
            else if (name === 'glob_repository_paths') result = await globRepositoryPaths(args);
            else if (name === 'search_repository_text') result = await searchRepositoryText(args);
            else throw new Error('Unknown repository scout tool.');
            return { content: [{ type: 'text', text: JSON.stringify(result) }] };
        } catch (error) {
            return {
                content: [{ type: 'text', text: error instanceof Error ? error.message : 'Tool failed.' }],
                isError: true,
            };
        }
    }
    throw new Error('Method not found.');
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', async line => {
    let request;
    try {
        request = JSON.parse(line);
        if (request.id === undefined) return;
        const result = await handleRequest(request);
        writeMessage({ jsonrpc: '2.0', id: request.id, result });
    } catch (error) {
        if (request && request.id !== undefined) {
            writeMessage({
                jsonrpc: '2.0',
                id: request.id,
                error: { code: -32603, message: error instanceof Error ? error.message : 'Request failed.' },
            });
        }
    }
});
`;

export function buildRepositoryScoutMcpConfig(): string {
    return JSON.stringify({
        mcpServers: {
            [REPOSITORY_SCOUT_SERVER_NAME]: {
                type: 'stdio',
                command: 'node',
                args: ['-e', REPOSITORY_SCOUT_MCP_SERVER_SOURCE],
                env: { PROPR_SCOUT_REPOSITORY_ROOT: '/home/node/workspace' },
            },
        },
    });
}
