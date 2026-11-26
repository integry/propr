import { calculateDelay } from '../../../utils/retryHandler.js';
import { constants } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import type { FlyConfig } from './config.js';
import { ExtensionStreamRedactor } from '../../../extensions/extensionOutput.js';
import { redactSecrets } from '../../../utils/secretRedaction.js';

export interface MachineLaunch {
    name: string;
    skip_service_registration: true;
    skip_secrets: true;
    region?: string;
    config: {
        image: string;
        guest: FlyConfig['guest'];
        metadata: { propr_run_id: string };
        auto_destroy: true;
        restart: { policy: 'no' };
        processes: { user: string; entrypoint: string[]; cmd: string[]; ignore_app_secrets: boolean }[];
        files: { guest_path: string; raw_value: string; mode: number }[];
    };
}

export const pollBackoff = (attempt: number) => calculateDelay(attempt, {
    baseDelay: 1000, maxDelay: 5000, exponentialBase: 2, jitter: true, maxAttempts: Infinity, retryableErrors: [],
});

interface MachineRecord {
    id: string;
    name: string;
    state?: string;
    events?: { timestamp: number; type: string }[];
}

export interface MachinesApi {
    create(launch: MachineLaunch, onBootStart?: (timestamp: number) => void): Promise<string>;
    exec(id: string, args: string[], signal?: AbortSignal): Promise<{ stdout: string; exit_code: number }>;
    signal(id: string, signal: NodeJS.Signals): Promise<void>;
    destroy(id: string): Promise<void>;
    /** True only when Fly confirms the Machine no longer exists (absent or `destroyed`); false while it may still exist. */
    gone(id: string): Promise<boolean>;
    /**
     * The ID of the Machine created with this unique launch name, or undefined when Fly lists none.
     * Throws when the lookup itself fails: that is not evidence of absence. Optional for test doubles;
     * without it a lost build Machine create cannot be confirmed either way.
     */
    find?(name: string): Promise<string | undefined>;
    logs(id: string, publish: (message: string) => void, signal: AbortSignal): Promise<void>;
}

interface RequestOptions {
    body?: unknown;
    signal?: AbortSignal;
    timeout?: number;
}

const ERROR_BODY_LIMIT = 64 * 1024;
export const ERROR_DETAIL_LIMIT = 300;

export class MachinesHttpError extends Error {
    constructor(readonly method: string, readonly status: number, detail?: string) {
        super(`Fly Machines API ${method} returned HTTP ${status}` + (detail ? ': ' + detail : ''));
    }
}

/**
 * A lost create response after which three lookups by the request's name found no Machine. Fly may
 * still be creating it, so this is not proof of absence: the build path keeps looking (see `derivedImage.ts`).
 */
export class MachineNotFoundAfterCreateError extends Error {}

/** Whether Fly refused the create request itself (HTTP 4xx on the POST), so no Machine of its name exists. */
export function createRejected(error: unknown): boolean {
    return error instanceof MachinesHttpError && error.status < 500 && error.method === 'POST';
}

async function readBounded(response: Response) {
    const reader = response.body?.getReader();
    if (!reader) return '';
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        while (size < ERROR_BODY_LIMIT) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            size += value.length;
        }
    } finally { await reader.cancel().catch(() => {}); }
    return Buffer.concat(chunks).subarray(0, ERROR_BODY_LIMIT).toString('utf8');
}

/**
 * Fly's validation message from an error body, or undefined. A create or exec
 * error body may echo the submitted configuration, so only the JSON `error`
 * string is kept: known secrets (and their base64, hex and URL spellings),
 * secret-shaped values and long opaque blobs such as file `raw_value`s are
 * redacted before it is truncated.
 */
export function flyErrorDetail(body: string, secrets: readonly string[] = []): string | undefined {
    let message: unknown;
    try { message = (JSON.parse(body) as { error?: unknown })?.error; } catch { return; }
    if (typeof message !== 'string') return;
    const redactor = new ExtensionStreamRedactor([...secrets]);
    let detail = redactSecrets(redactor.push(message) + redactor.finish())
        .replace(/[A-Za-z0-9+/_-]{80,}={0,2}/g, '[REDACTED]')
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
    if (detail.length > ERROR_DETAIL_LIMIT) detail = detail.slice(0, ERROR_DETAIL_LIMIT - 1) + '…';
    return detail || undefined;
}

export class MachinesClient implements MachinesApi {
    private readonly url: string;
    private readonly authorization: string;
    /** `secrets` are redacted from any Fly error message surfaced in a run failure. */
    constructor(private readonly config: FlyConfig, private readonly secrets: readonly string[] = []) {
        this.url = 'https://api.machines.dev/v1/apps/' + config.app + '/machines';
        this.authorization = config.token.startsWith('FlyV1 ') ? config.token : 'Bearer ' + config.token;
    }

    private async request(method: string, url: string, { body, signal, timeout = 30_000 }: RequestOptions = {}) {
        const deadline = AbortSignal.timeout(timeout);
        const response = await fetch(url, { method, redirect: 'error',
            headers: { Authorization: this.authorization, 'Content-Type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: signal ? AbortSignal.any([deadline, signal]) : deadline });
        // A create or exec error body may echo the submitted configuration:
        // surface only Fly's redacted, truncated `error` string.
        if (!response.ok && !(method === 'DELETE' && response.status === 404)) {
            const body = await readBounded(response).catch(() => '');
            throw new MachinesHttpError(method, response.status, flyErrorDetail(body, [this.config.token, ...this.secrets]));
        }
        return response;
    }

    async create(launch: MachineLaunch, onBootStart?: (timestamp: number) => void) {
        const identify = (machine: MachineRecord) => {
            if (!machine.id || !/^[a-zA-Z0-9-]+$/.test(machine.id)) throw new Error('Fly create returned no Machine ID');
            for (const event of machine.events ?? []) {
                if (['launch', 'create', 'pull'].includes(event.type) && Number.isSafeInteger(event.timestamp) && event.timestamp > 0)
                    onBootStart?.(event.timestamp);
            }
            return machine.id;
        };
        try {
            const response = await this.request('POST', this.url, { body: launch, timeout: this.config.bootTimeout });
            return identify(await response.json() as MachineRecord);
        } catch (error) {
            if (createRejected(error)) throw error;
            // A lost create response can still have launched the agent. Adopt
            // only this request's UUID-named Machine; never POST a second run.
            const message = error instanceof Error ? error.message : String(error);
            for (let attempt = 0; attempt < 3; attempt++) {
                if (attempt) await delay(1000);
                let found: MachineRecord | undefined;
                // A failed lookup (any status) says nothing about the Machine: never report it as a refusal.
                try { found = await this.lookup(launch.name); }
                catch (lookup) {
                    throw new Error(`${message}; the lookup by name failed too: ${lookup instanceof Error ? lookup.message : String(lookup)}`, { cause: error });
                }
                if (found) return identify(found);
            }
            // Every lookup succeeded without finding it. A create still in flight at Fly
            // could appear later; that race between the two API calls cannot be closed here.
            throw new MachineNotFoundAfterCreateError(message, { cause: error });
        }
    }

    async find(name: string) {
        return (await this.lookup(name))?.id;
    }

    private async lookup(name: string) {
        const response = await this.request('GET', this.url + '?metadata.propr_run_id=' + encodeURIComponent(name));
        const machines = await response.json() as MachineRecord[];
        return machines.find(m => m.name === name && /^[a-zA-Z0-9-]+$/.test(m.id));
    }

    async gone(id: string) {
        let record: MachineRecord;
        try { record = await (await this.request('GET', this.url + '/' + id)).json() as MachineRecord; }
        catch (error) { if (error instanceof MachinesHttpError && error.status === 404) return true; throw error; }
        return record.state === 'destroyed';
    }

    async exec(id: string, command: string[], signal?: AbortSignal) {
        const response = await this.request('POST', this.url + '/' + id + '/exec', { body: { command, timeout: 20 }, signal });
        const result = await response.json() as { stdout: string; exit_code: number; exit_signal?: number };
        if (typeof result.stdout !== 'string' || !Number.isInteger(result.exit_code) || result.exit_signal) throw new Error('Invalid Fly exec response');
        return result;
    }

    async signal(id: string, signal: NodeJS.Signals) {
        const url = this.url + '/' + id + '/signal';
        try {
            await this.request('POST', url, { body: { signal } });
        } catch (error) {
            if (error instanceof MachinesHttpError && error.status === 404) return; // Already gone.
            if (!(error instanceof MachinesHttpError) || error.status !== 400) throw error;
            // Older Machines API hosts accept the POSIX number.
            await this.request('POST', url, { body: { signal: constants.signals[signal] } });
        }
    }

    async destroy(id: string) {
        await this.request('DELETE', this.url + '/' + id + '?force=true&kill=true');
    }

    async logs(id: string, publish: (message: string) => void, signal: AbortSignal) {
        const query = new URLSearchParams({ instance: id });
        let failures = 0;
        let previousPage = new Set<string>();
        while (!signal.aborted) {
            let interval = 1500;
            try {
                const url = 'https://api.fly.io/api/v1/apps/' + this.config.app + '/logs?' + query;
                const response = await this.request('GET', url, { signal });
                const page = await response.json() as { data: { id?: string; attributes: { message: string; instance: string } }[]; meta?: { next_token?: string } };
                const seen = new Set<string>();
                for (const entry of page.data) {
                    const key = entry.id ?? JSON.stringify(entry.attributes);
                    if (entry.attributes.instance === id && !previousPage.has(key)) publish(entry.attributes.message);
                    seen.add(key);
                }
                previousPage = seen;
                if (page.meta?.next_token) query.set('next_token', page.meta.next_token);
                failures = 0;
            } catch {
                interval = pollBackoff(failures++);
            }
            await delay(interval, undefined, { signal }).catch(() => {});
        }
    }
}
