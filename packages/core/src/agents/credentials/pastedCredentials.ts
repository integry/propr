import {
    getPastedAgentCredentialDefinition,
    pastedAgentCredentialDefinitions,
    type PastedAgentCredentialDefinition,
    type PastedAgentCredentialKind,
    type PastedAgentCredentialStatus,
} from '@propr/shared';
import type { AgentType } from '../types.js';
import { isLoginCredentialEntry, providerCredentialManifest, type CredentialStoreKind } from './providerManifests.js';

/**
 * How a pasted credential changes the provider file that holds it. The file
 * and its store come from the shared definition, and are always entries of
 * the provider's credential manifest, so every runtime that materialises the
 * manifest picks the credential up.
 */

export class PastedCredentialError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'PastedCredentialError';
    }
}

/** Largest pasted document (auth.json files are a few KiB). */
export const MAX_PASTED_CREDENTIAL_BYTES = 64 * 1024;

const CLAUDE_ENV: Partial<Record<PastedAgentCredentialKind, string>> = {
    'anthropic-api-key': 'ANTHROPIC_API_KEY',
    'claude-oauth-token': 'CLAUDE_CODE_OAUTH_TOKEN',
};

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseObject(content: string, what: string): JsonObject {
    let parsed: unknown;
    try { parsed = JSON.parse(content); }
    catch { throw new PastedCredentialError(`${what} is not valid JSON`); }
    if (!isObject(parsed)) throw new PastedCredentialError(`${what} must be a JSON object`);
    return parsed;
}

/** The current file as an object; a missing or empty file is `{}`, an unreadable one is refused rather than overwritten. */
function existingObject(current: Buffer | undefined, path: string): JsonObject {
    const text = current?.toString('utf8').trim();
    if (!text) return {};
    return parseObject(text, `The existing ${path}`);
}

function singleToken(value: string, label: string): string {
    const token = value.trim();
    if (!token) throw new PastedCredentialError(`${label} is empty`);
    if (token.length > 4096 || /\s/.test(token) || [...token].some(character => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f)) {
        throw new PastedCredentialError(`${label} must be a single line without spaces`);
    }
    return token;
}

function serialize(value: JsonObject): Buffer {
    return Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function requireDefinition(kind: string): PastedAgentCredentialDefinition {
    const definition = getPastedAgentCredentialDefinition(kind);
    if (!definition) throw new PastedCredentialError(`Unknown credential kind "${kind}"`);
    if (!providerCredentialManifest(definition.provider, definition.store)?.entries.some(entry => entry.path === definition.path)) {
        // A definition must name a manifest file, or remote runtimes would never see it.
        throw new PastedCredentialError(`Credential kind "${kind}" is not part of the ${definition.provider} credential manifest`);
    }
    return definition;
}

function validateCodexAuth(auth: JsonObject): void {
    const apiKey = auth.OPENAI_API_KEY;
    const tokens = auth.tokens;
    const hasKey = typeof apiKey === 'string' && apiKey.trim().length > 0;
    const hasTokens = isObject(tokens) && ['access_token', 'refresh_token'].some(name => typeof tokens[name] === 'string' && (tokens[name] as string).length > 0);
    if (!hasKey && !hasTokens) {
        throw new PastedCredentialError('auth.json has neither an OPENAI_API_KEY nor ChatGPT login tokens. Copy ~/.codex/auth.json after `codex login`.');
    }
}

function validateOpenCodeAuth(auth: JsonObject): void {
    const providers = Object.entries(auth);
    if (providers.length === 0) throw new PastedCredentialError('auth.json lists no providers. Copy it after `opencode auth login`.');
    for (const [provider, entry] of providers) {
        if (!isObject(entry) || typeof entry.type !== 'string') {
            throw new PastedCredentialError(`auth.json entry "${provider}" has no "type"`);
        }
    }
}

/**
 * The new content of the definition's file after storing `value`. The
 * existing file is merged where it holds other settings (Claude's
 * settings.json); login documents (auth.json) are replaced.
 */
export function applyPastedCredential(kind: PastedAgentCredentialKind, value: string, current: Buffer | undefined): Buffer {
    const definition = requireDefinition(kind);
    if (typeof value !== 'string' || Buffer.byteLength(value) > MAX_PASTED_CREDENTIAL_BYTES) {
        throw new PastedCredentialError(`${definition.label} must be a string of at most ${MAX_PASTED_CREDENTIAL_BYTES / 1024} KiB`);
    }
    switch (kind) {
        case 'anthropic-api-key':
        case 'claude-oauth-token': {
            const token = singleToken(value, definition.label);
            const settings = existingObject(current, definition.path);
            const env = isObject(settings.env) ? { ...settings.env } : {};
            // One authentication method at a time: a stale key would win over a new token.
            for (const name of Object.values(CLAUDE_ENV)) delete env[name!];
            env[CLAUDE_ENV[kind]!] = token;
            return serialize({ ...settings, env });
        }
        case 'openai-api-key':
            // The shape `codex login --with-api-key` writes.
            return serialize({ OPENAI_API_KEY: singleToken(value, definition.label), tokens: null, last_refresh: null });
        case 'codex-auth-json': {
            const auth = parseObject(value.trim(), 'The pasted auth.json');
            validateCodexAuth(auth);
            return serialize(auth);
        }
        case 'opencode-auth-json': {
            const auth = parseObject(value.trim(), 'The pasted auth.json');
            validateOpenCodeAuth(auth);
            return serialize(auth);
        }
    }
}

/** The new content after removing the kind: `null` deletes the file. */
export function removePastedCredential(kind: PastedAgentCredentialKind, current: Buffer | undefined): Buffer | null {
    const definition = requireDefinition(kind);
    if (kind === 'anthropic-api-key' || kind === 'claude-oauth-token') {
        const settings = existingObject(current, definition.path);
        if (!isObject(settings.env)) return current ?? null;
        const env = { ...settings.env };
        delete env[CLAUDE_ENV[kind]!];
        const next: JsonObject = { ...settings, env };
        if (Object.keys(env).length === 0) delete next.env;
        return serialize(next);
    }
    if (kind === 'openai-api-key' || kind === 'codex-auth-json') return removeCodexCredential(kind, current, definition.path);
    // OpenCode's auth.json is its only pasted kind; removing it removes the file.
    return null;
}

/**
 * Both Codex kinds live in the same auth.json, so the kind being removed is
 * checked against the current file (read under the store lock): removing a
 * kind the file no longer holds, because the other kind has since replaced
 * it, leaves the replacement in place. A file holding both drops only the
 * removed one.
 */
function removeCodexCredential(kind: 'openai-api-key' | 'codex-auth-json', current: Buffer | undefined, path: string): Buffer | null {
    const auth = existingObject(current, path);
    const hasKey = STORED_SECRET['openai-api-key'](auth) !== undefined;
    const hasLogin = STORED_SECRET['codex-auth-json'](auth) !== undefined;
    if (kind === 'openai-api-key') {
        if (!hasKey) return current ?? null;
        return hasLogin ? serialize({ ...auth, OPENAI_API_KEY: null }) : null;
    }
    if (!hasLogin) return current ?? null;
    return hasKey ? serialize({ OPENAI_API_KEY: auth.OPENAI_API_KEY, tokens: null, last_refresh: null }) : null;
}

/**
 * Claude's settings.json once an interactive login is stored: the pasted
 * authentication variables are removed (they would override the new login),
 * other settings are kept. Undefined when nothing changes; an unreadable
 * existing file is refused rather than overwritten.
 */
export function withoutPastedClaudeAuthentication(current: Buffer | undefined): Buffer | undefined {
    const settings = existingObject(current, 'settings.json');
    if (!isObject(settings.env)) return undefined;
    const env = { ...settings.env };
    const names = Object.values(CLAUDE_ENV).filter(name => name! in env) as string[];
    if (names.length === 0) return undefined;
    for (const name of names) delete env[name];
    const next: JsonObject = { ...settings, env };
    if (Object.keys(env).length === 0) delete next.env;
    return serialize(next);
}

const last4 = (value: string) => value.length >= 8 ? value.slice(-4) : undefined;

function safeObject(current: Buffer | undefined): JsonObject | undefined {
    try { return current ? existingObject(current, 'file') : undefined; }
    catch { return undefined; }
}

const nonEmpty = (value: unknown): string | undefined => typeof value === 'string' && value ? value : undefined;

function openCodeSecret(file: JsonObject): string | undefined {
    for (const entry of Object.values(file)) {
        if (!isObject(entry)) continue;
        const token = nonEmpty(entry.key) ?? nonEmpty(entry.refresh) ?? nonEmpty(entry.access);
        if (token) return token;
    }
    return Object.keys(file).length > 0 ? '' : undefined;
}

const STORED_SECRET: Record<PastedAgentCredentialKind, (file: JsonObject) => string | undefined> = {
    'anthropic-api-key': file => nonEmpty(isObject(file.env) ? file.env.ANTHROPIC_API_KEY : undefined),
    'claude-oauth-token': file => nonEmpty(isObject(file.env) ? file.env.CLAUDE_CODE_OAUTH_TOKEN : undefined),
    'openai-api-key': file => nonEmpty(file.OPENAI_API_KEY),
    'codex-auth-json': file => {
        const tokens = isObject(file.tokens) ? file.tokens : undefined;
        return nonEmpty(tokens?.refresh_token) ?? nonEmpty(tokens?.access_token);
    },
    'opencode-auth-json': openCodeSecret,
};

/** The secret a stored kind is identified by, or undefined when the kind is not set. */
function storedSecret(kind: PastedAgentCredentialKind, current: Buffer | undefined): string | undefined {
    const file = safeObject(current);
    return file ? STORED_SECRET[kind](file) : undefined;
}

export type CredentialFileReader = (store: CredentialStoreKind, path: string) => Buffer | undefined;

/** Whether each pasted kind of the provider is set, with the last four characters of its secret; never the value. */
export function describePastedCredentials(provider: AgentType, read: CredentialFileReader): PastedAgentCredentialStatus[] {
    return pastedAgentCredentialDefinitions(provider).map(definition => {
        const secret = storedSecret(definition.kind, read(definition.store, definition.path));
        if (secret === undefined) return { kind: definition.kind, set: false };
        const suffix = last4(secret);
        return { kind: definition.kind, set: true, ...(suffix ? { last4: suffix } : {}) };
    });
}

/** Whether a login file the provider's manifest declares (other than a pasted kind's file) is present. */
export function storedLoginPresent(provider: AgentType, read: CredentialFileReader): boolean {
    const pastedPaths = new Set(pastedAgentCredentialDefinitions(provider).map(definition => `${definition.store}:${definition.path}`));
    return (['config', 'data'] as const).some(store => (providerCredentialManifest(provider, store)?.entries ?? [])
        .filter(entry => isLoginCredentialEntry(entry) && !pastedPaths.has(`${store}:${entry.path}`))
        .some(entry => (read(store, entry.path)?.length ?? 0) > 0));
}
