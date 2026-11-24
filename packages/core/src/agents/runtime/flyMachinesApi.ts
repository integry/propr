import type { FlyMachineGuest, FlyMachinesConfig } from './flyMachinesConfig.js';

/**
 * Minimal Fly Machines API client (https://fly.io/docs/machines/api/) over
 * `fetch`: create, list, inspect, wait, signal, stop and destroy a Machine,
 * exec in it, and page its logs. Only what the agent runtime uses.
 */

export interface FlyMachineFile {
    guest_path: string;
    /** Base64 content. */
    raw_value: string;
    mode?: number;
}

export interface FlyMachineConfigBody {
    image: string;
    init: { entrypoint?: string[]; cmd?: string[]; exec?: string[] };
    /**
     * Process overrides. `init` has no user field, so Fly starts the process
     * as the image's `USER` unless a process sets `user`; a process that
     * sets only `user` runs the image's default command instead of `init`'s,
     * so it has to carry the entrypoint and command as well.
     */
    processes?: Array<{ user?: string; entrypoint?: string[]; cmd?: string[]; exec?: string[]; env?: Record<string, string> }>;
    env: Record<string, string>;
    guest: FlyMachineGuest;
    files?: FlyMachineFile[];
    metadata?: Record<string, string>;
    auto_destroy: boolean;
    restart: { policy: 'no' | 'always' | 'on-failure' };
    stop_config?: { signal?: string; timeout?: string };
}

export interface FlyCreateMachineRequest {
    name?: string;
    region?: string;
    config: FlyMachineConfigBody;
    skip_service_registration?: boolean;
}

export interface FlyMachineEvent {
    type?: string;
    status?: string;
    timestamp?: number;
    request?: { exit_event?: { exit_code?: number; guest_exit_code?: number; oom_killed?: boolean; requested_stop?: boolean; signal?: number } };
}

export interface FlyMachine {
    id: string;
    name?: string;
    state?: string;
    region?: string;
    instance_id?: string;
    private_ip?: string;
    events?: FlyMachineEvent[];
    config?: { metadata?: Record<string, string> };
}

export interface FlyExecResult {
    exit_code: number;
    stdout: string;
    stderr: string;
}

export interface FlyLogLine {
    timestamp: string;
    message: string;
}

export interface FlyLogPage {
    lines: FlyLogLine[];
    nextToken?: string;
}

export class FlyMachinesApiError extends Error {
    constructor(message: string, readonly status: number) {
        super(message);
        this.name = 'FlyMachinesApiError';
    }
}

/** Machines an org on Fly's Free plan may have at once, across all of its apps. */
export const FLY_FREE_PLAN_MACHINE_LIMIT = 3;

/**
 * A create refused because the org has as many Machines as its plan allows
 * (HTTP 422, "Your organization has reached its machine limit"). It is a
 * definite refusal: no Machine was created.
 */
export class FlyMachineLimitError extends FlyMachinesApiError {
    constructor(readonly detail: string) {
        super(
            `Fly Machines API refused to create a Machine: ${detail}. Every Machine in the Fly organization counts toward its limit, `
            + 'across all of its apps: the ProPR control plane, other apps, and run Machines that still exist (a run being read, a run '
            + 'kept because its result or refreshed credentials could not be read, or a finished run waiting out PROPR_FLY_RESULT_LINGER_SECONDS '
            + `after its worker went away). The Fly Free plan allows ${FLY_FREE_PLAN_MACHINE_LIMIT} Machines, which fits about one concurrent `
            + 'run next to the control plane; Sprites is the recommended runtime on the Free plan. Destroy leftover Machines '
            + '(fly machines list -a <app>) or raise the organization\'s limit.',
            422,
        );
        this.name = 'FlyMachineLimitError';
    }
}

/** Whether an API error body is the org Machine-limit refusal. */
export function isFlyMachineLimitRefusal(status: number, detail: string): boolean {
    return status === 422 && /machine limit/i.test(detail);
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** `signal` aborts the request (on top of its own timeout): the caller no longer waits for it. */
export interface FlyRequestOptions {
    signal?: AbortSignal;
}

const REQUEST_TIMEOUT_MS = 30_000;

/** Deploy tokens (`FlyV1 ...`) are sent as they are; older personal tokens as a bearer token. */
export function flyAuthorization(token: string): string {
    return /^FlyV1\s/.test(token) ? token : `Bearer ${token}`;
}

/** POSIX shell quoting, for the API's legacy string form of an exec command. */
function shellQuote(word: string): string {
    return /^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

export class FlyMachinesClient {
    constructor(
        private readonly config: Pick<FlyMachinesConfig, 'apiUrl' | 'logsApiUrl' | 'token' | 'app'>,
        private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init),
    ) {}

    private machinesUrl(suffix = ''): string {
        return `${this.config.apiUrl}/apps/${encodeURIComponent(this.config.app)}/machines${suffix}`;
    }

    private async request<T>(method: string, url: string, options: FlyRequestOptions & { body?: unknown; allow?: number[]; timeoutMs?: number } = {}): Promise<{ status: number; body: T | undefined }> {
        const timeout = AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS);
        const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
        const response = await this.fetchImpl(url, {
            method,
            headers: {
                Authorization: flyAuthorization(this.config.token),
                Accept: 'application/json',
                ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
            },
            ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
            signal,
        });
        const text = await response.text();
        if (!response.ok && !options.allow?.includes(response.status)) {
            // The API's error body names the problem; it never echoes the token.
            let detail = text.trim().slice(0, 500);
            try { detail = (JSON.parse(text) as { error?: string }).error ?? detail; } catch { /* plain text */ }
            if (isFlyMachineLimitRefusal(response.status, detail)) throw new FlyMachineLimitError(detail);
            throw new FlyMachinesApiError(`Fly Machines API ${method} ${new URL(url).pathname} returned ${response.status}${detail ? `: ${detail}` : ''}`, response.status);
        }
        let body: T | undefined;
        if (text) {
            try { body = JSON.parse(text) as T; } catch { body = undefined; }
        }
        return { status: response.status, body };
    }

    async createMachine(request: FlyCreateMachineRequest): Promise<FlyMachine> {
        // Creation includes the image pull when the host has not cached it.
        const { body } = await this.request<FlyMachine>('POST', this.machinesUrl(), { body: request, timeoutMs: 120_000 });
        if (!body?.id) throw new FlyMachinesApiError('Fly Machines API created a Machine without returning its id', 502);
        return body;
    }

    /** The Machine, or null once it is gone (destroyed Machines eventually return 404). */
    async getMachine(id: string, options: FlyRequestOptions = {}): Promise<FlyMachine | null> {
        const { status, body } = await this.request<FlyMachine>('GET', this.machinesUrl(`/${encodeURIComponent(id)}`), { allow: [404], signal: options.signal });
        return status === 404 ? null : body ?? null;
    }

    /**
     * The app's Machines (destroyed ones excluded) whose metadata holds every
     * pair in `metadata`. The API filters by it; the result is filtered here
     * too, so a Machine without those pairs is never returned, whatever the
     * API applied. Throws unless the API returned a list.
     */
    async listMachines(metadata: Record<string, string>, options: FlyRequestOptions = {}): Promise<FlyMachine[]> {
        const query = new URLSearchParams(Object.entries(metadata).map(([key, value]): [string, string] => [`metadata.${key}`, value]));
        const { body } = await this.request<FlyMachine[]>('GET', this.machinesUrl(`?${query}`), { signal: options.signal });
        if (!Array.isArray(body)) throw new FlyMachinesApiError('Fly Machines API listed Machines without returning a list', 502);
        return body.filter(machine => !!machine?.id && Object.entries(metadata).every(([key, value]) => machine.config?.metadata?.[key] === value));
    }

    /** Waits up to `timeoutSeconds` (max 60) for `state` (of `instanceId`, when given); false when it was not reached in time. */
    async waitForState(id: string, state: 'started' | 'stopped' | 'destroyed', timeoutSeconds: number, options: FlyRequestOptions & { instanceId?: string } = {}): Promise<boolean> {
        const query = new URLSearchParams({ state, timeout: String(Math.max(1, Math.min(60, Math.ceil(timeoutSeconds)))) });
        if (options.instanceId) query.set('instance_id', options.instanceId);
        const { status } = await this.request('GET', this.machinesUrl(`/${encodeURIComponent(id)}/wait?${query}`), {
            allow: [408], timeoutMs: (timeoutSeconds + 15) * 1000, signal: options.signal,
        });
        return status !== 408;
    }

    /** Sends `signal` to the Machine's main process. */
    async signal(id: string, signal: number, options: FlyRequestOptions = {}): Promise<void> {
        await this.request('POST', this.machinesUrl(`/${encodeURIComponent(id)}/signal`), { body: { signal }, signal: options.signal });
    }

    async stopMachine(id: string, options: { signal?: string; timeoutSeconds?: number } = {}): Promise<void> {
        await this.request('POST', this.machinesUrl(`/${encodeURIComponent(id)}/stop`), {
            body: { ...(options.signal ? { signal: options.signal } : {}), ...(options.timeoutSeconds !== undefined ? { timeout: `${options.timeoutSeconds}s` } : {}) },
            allow: [404],
        });
    }

    /** Destroys the Machine (killing it when still running). A Machine already gone counts as destroyed. */
    async destroyMachine(id: string): Promise<void> {
        await this.request('DELETE', this.machinesUrl(`/${encodeURIComponent(id)}?force=true&kill=true`), { allow: [404] });
    }

    async exec(id: string, command: string[], timeoutSeconds = 60, options: FlyRequestOptions = {}): Promise<FlyExecResult> {
        const { body } = await this.request<Partial<FlyExecResult>>('POST', this.machinesUrl(`/${encodeURIComponent(id)}/exec`), {
            body: { command, cmd: command.map(shellQuote).join(' '), timeout: timeoutSeconds },
            timeoutMs: (timeoutSeconds + 15) * 1000, signal: options.signal,
        });
        return { exit_code: body?.exit_code ?? 0, stdout: body?.stdout ?? '', stderr: body?.stderr ?? '' };
    }

    /** One page of the Machine's logs after `nextToken` (oldest first). */
    async logs(machineId: string, nextToken?: string, options: FlyRequestOptions = {}): Promise<FlyLogPage> {
        const query = new URLSearchParams({ instance: machineId });
        if (nextToken) query.set('next_token', nextToken);
        const { body } = await this.request<{ data?: Array<{ attributes?: { timestamp?: string; message?: string } }>; meta?: { next_token?: string } }>(
            'GET', `${this.config.logsApiUrl}/apps/${encodeURIComponent(this.config.app)}/logs?${query}`, { signal: options.signal },
        );
        const lines = (body?.data ?? [])
            .map(entry => ({ timestamp: entry.attributes?.timestamp ?? '', message: entry.attributes?.message ?? '' }));
        return { lines, ...(body?.meta?.next_token ? { nextToken: body.meta.next_token } : {}) };
    }
}

/** The agent's exit status from a stopped Machine's exit event, when Fly recorded one. */
export function flyMachineExitCode(machine: FlyMachine | null): number | null {
    for (const event of [...(machine?.events ?? [])].sort((left, right) => (right.timestamp ?? 0) - (left.timestamp ?? 0))) {
        const exit = event.request?.exit_event;
        if (exit) return exit.exit_code ?? exit.guest_exit_code ?? null;
    }
    return null;
}

/** `stat -c "%s %Y %y"`: size, whole seconds, and the human timestamp whose fraction gives sub-second precision. */
export function parseFlyStat(output: string): { size: number; mtimeMs: number } | undefined {
    const [sizeText, secondsText, ...human] = output.trim().split(/\s+/);
    const size = Number(sizeText);
    const seconds = Number(secondsText);
    if (!Number.isSafeInteger(size) || size < 0 || !Number.isFinite(seconds)) return undefined;
    const fraction = /\.(\d+)$/.exec(human[1] ?? '')?.[1];
    return { size, mtimeMs: seconds * 1000 + (fraction ? Math.floor(Number(`0.${fraction}`) * 1000) : 0) };
}
