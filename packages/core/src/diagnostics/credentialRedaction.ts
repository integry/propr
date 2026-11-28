import path from 'node:path';
import { isManagedAgentConfigPath } from '@propr/shared';
import { parse as parseEnv } from 'dotenv';
import fs from 'node:fs';
import { PinnedDirectory } from './privateDirectory.js';

/** Read only known credential sources for redaction, never for export. A malformed,
 * oversized, linked or unreadable store refuses collection instead of leaking an
 * opaque configured credential. No recursive home/config traversal. */
export function nativeCredentialValues(root: string, provider: string, pinned?: PinnedDirectory): string[] {
    const names: Record<string, string[]> = {
        codex: ['auth.json'], claude: ['.credentials.json'],
        opencode: ['auth.json', 'account.json'], antigravity: ['oauth_creds.json', 'antigravity-cli/antigravity-oauth-token'], vibe: ['credentials.json', '.env'],
        pi: ['auth.json', 'models.json'],
    };
    let dir: PinnedDirectory;
    try { dir = pinned ?? PinnedDirectory.open(root); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; }
    const values: string[] = [];
    let size = 0;
    const walk = (value: unknown, depth = 0): void => {
        if (depth > 16) throw new Error('unsafe credential structure');
        if (typeof value === 'string' && value) {
            size += value.length;
            if (size > 128 * 1024 || values.length >= 256) throw new Error('credential redaction bound');
            values.push(value);
            // PEM lines must remain redacted even in split text diagnostics.
            if (value.includes('\n')) values.push(...value.split('\n').filter(v => v.length >= 8));
        } else if (value && typeof value === 'object') for (const v of Object.values(value)) walk(v, depth + 1);
    };
    try {
        for (const name of names[provider] ?? []) {
            let fd: number | undefined;
            const children: PinnedDirectory[] = [];
            try {
                let parent = dir;
                const parts = name.split('/');
                for (const part of parts.slice(0, -1)) { parent = parent.child(part); children.push(parent); }
                fd = parent.file(parts.at(-1)!);
                const content = readCredentialContent(fd);
                if (provider === 'pi') readPiCredentials(name, content, walk);
                else walk(parseCredentialContent(name, content));
            } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('credential redaction unavailable'); }
            finally { if (fd !== undefined) fs.closeSync(fd); for (const child of children.reverse()) child.close(); }
        }
    } finally { if (!pinned) dir.close(); }
    return values;
}

function credentialObject(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('unsupported credential format');
    return value as Record<string, unknown>;
}

function parsePiModels(content: string): unknown {
    // Pi permits a BOM and JSON comments. Preserve quoted strings, including URLs.
    return JSON.parse(content.replace(/^\uFEFF/, '').replace(/"(?:[^"\\]|\\[\s\S])*"?|\/\/[^\r\n]*|\/\*[\s\S]*?(?:\*\/|$)/g, token => {
        if (token.startsWith('"')) return token;
        if (token.startsWith('/*') && !token.endsWith('*/')) throw new Error('unterminated JSON comment');
        return ' ';
    }));
}

function readPiConfigValue(value: unknown, add: (secret: string) => void): void {
    if (typeof value !== 'string' || value.startsWith('!')) throw new Error('unresolved Pi credential');
    // Only static values can be established here. Command output and environment
    // interpolation depend on the Pi process (or the host session's environment).
    const literal = value.replace(/\$(?:([$!])|[A-Za-z_]|\{)/g, (_match, escaped?: string) => {
        if (escaped === undefined) throw new Error('unresolved Pi credential');
        return escaped;
    });
    if (literal && literal.length < 8) throw new Error('Pi credential below redaction minimum');
    add(literal);
    if (literal !== value) add(value);
}

function readPiCredentials(name: string, content: string, add: (value: unknown, depth?: number) => void): void {
    if (name === 'models.json') {
        readPiModelCredentials(parsePiModels(content), add);
        return;
    }
    for (const entry of Object.values(credentialObject(JSON.parse(content)))) {
        const { key, ...credential } = credentialObject(entry);
        if (credential.type === 'api_key') readPiConfigValue(key, add);
        else add(key, 2);
        add(credential, 1);
    }
}

function readPiModelCredentials(parsed: unknown, add: (secret: string) => void): void {
    const { providers } = credentialObject(parsed);
    if (providers === undefined) return;
    const readHeaders = (entry: Record<string, unknown>) => {
        if (entry.headers === undefined) return;
        for (const header of Object.values(credentialObject(entry.headers))) readPiConfigValue(header, add);
    };
    for (const entry of Object.values(credentialObject(providers))) {
        const provider = credentialObject(entry);
        const { apiKey, models, modelOverrides } = provider;
        if (apiKey !== undefined) readPiConfigValue(apiKey, add);
        readHeaders(provider);
        if (models !== undefined) {
            if (!Array.isArray(models)) throw new Error('unsupported credential format');
            for (const model of models) readHeaders(credentialObject(model));
        }
        if (modelOverrides !== undefined) {
            for (const model of Object.values(credentialObject(modelOverrides))) readHeaders(credentialObject(model));
        }
    }
}

function readCredentialContent(fd: number): string {
    const before = fs.fstatSync(fd, { bigint: true });
    if (before.size > 64 * 1024) throw new Error('credential redaction bound');
    const buffer = Buffer.alloc(64 * 1024 + 1);
    const n = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const after = fs.fstatSync(fd, { bigint: true });
    if (BigInt(n) !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) {
        throw new Error('credential file changed while reading');
    }
    return buffer.subarray(0, n).toString('utf8');
}

function parseCredentialContent(name: string, content: string): unknown {
    if (name === '.env') {
        for (const line of content.split(/\r?\n/)) {
            if (line.trim() && !line.trim().startsWith('#') && !/^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=/.test(line)) throw new Error('unsupported credential format');
        }
        return parseEnv(content);
    }
    if (name.endsWith('antigravity-oauth-token') && /^[A-Za-z0-9._-]+\s*$/.test(content)) return content.trim();
    return JSON.parse(content);
}

/** Shared with the provider launch path, including legacy .antigravity homes. */
export function antigravityCredentialRoot(configPath: string, resolve: (value: string) => string, env: Record<string, string | undefined> = process.env): string {
    const managed = isManagedAgentConfigPath(configPath);
    const root = resolve(managed ? configPath : env.ANTIGRAVITY_CONFIG_PATH || configPath);
    if (!managed && path.basename(root) === '.antigravity') {
        const sibling = path.join(path.dirname(root), '.gemini');
        if (fs.existsSync(sibling) && fs.statSync(sibling).isDirectory()) return sibling;
    }
    return root;
}
