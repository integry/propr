import { constants } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import type { FlyConfig } from './config.js';

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

export interface MachinesApi {
    create(launch: MachineLaunch): Promise<string>;
    exec(id: string, args: string[], signal?: AbortSignal): Promise<{ stdout: string; exit_code: number }>;
    signal(id: string, signal: NodeJS.Signals): Promise<void>;
    destroy(id: string): Promise<void>;
    logs(id: string, publish: (message: string) => void, signal: AbortSignal): Promise<void>;
}

interface RequestOptions {
    body?: unknown;
    signal?: AbortSignal;
    timeout?: number;
}

class MachinesHttpError extends Error {
    constructor(method: string, readonly status: number) {
        super(`Fly Machines API ${method} returned HTTP ${status}`);
    }
}

export class MachinesClient implements MachinesApi {
    private readonly url: string;
    private readonly authorization: string;
    constructor(private readonly config: FlyConfig) {
        this.url = 'https://api.machines.dev/v1/apps/' + config.app + '/machines';
        this.authorization = config.token.startsWith('FlyV1 ') ? config.token : 'Bearer ' + config.token;
    }

    private async request(method: string, url: string, { body, signal, timeout = 30_000 }: RequestOptions = {}) {
        const deadline = AbortSignal.timeout(timeout);
        const response = await fetch(url, { method, redirect: 'error',
            headers: { Authorization: this.authorization, 'Content-Type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: signal ? AbortSignal.any([deadline, signal]) : deadline });
        // A create or exec error body may echo the submitted configuration.
        if (!response.ok && !(method === 'DELETE' && response.status === 404)) {
            throw new MachinesHttpError(method, response.status);
        }
        return response;
    }

    async create(launch: MachineLaunch) {
        try {
            const response = await this.request('POST', this.url, { body: launch, timeout: 120_000 });
            const { id } = await response.json() as { id?: string };
            if (!id || !/^[a-zA-Z0-9-]+$/.test(id)) throw new Error('Fly create returned no Machine ID');
            return id;
        } catch (error) {
            if (error instanceof MachinesHttpError && error.status < 500) throw error;
            // A lost create response can still have launched the agent. Adopt
            // only this request's UUID-named Machine; never POST a second run.
            for (let attempt = 0; attempt < 3; attempt++) {
                if (attempt) await delay(1000);
                const response = await this.request('GET', this.url + '?metadata.propr_run_id=' + encodeURIComponent(launch.name));
                const machines = await response.json() as Array<{ name: string; id: string }>;
                const found = machines.find(m => m.name === launch.name && /^[a-zA-Z0-9-]+$/.test(m.id));
                if (found) return found.id;
            }
            throw error;
        }
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
            if (!(error instanceof MachinesHttpError) || error.status !== 400) throw error;
            // Older Machines API hosts accept the POSIX number.
            await this.request('POST', url, { body: { signal: constants.signals[signal] } });
        }
    }

    async destroy(id: string) {
        for (let attempt = 0; ; attempt++) {
            try {
                await this.request('DELETE', this.url + '/' + id + '?force=true&kill=true');
                return;
            } catch (error) {
                if (attempt >= 2) throw error;
                await delay(500 * (attempt + 1));
            }
        }
    }

    async logs(id: string, publish: (message: string) => void, signal: AbortSignal) {
        const query = new URLSearchParams({ instance: id });
        while (!signal.aborted) {
            const url = 'https://api.fly.io/api/v1/apps/' + this.config.app + '/logs?' + query;
            const response = await this.request('GET', url, { signal });
            const page = await response.json() as { data: { attributes: { message: string; instance: string } }[]; meta?: { next_token?: string } };
            for (const { attributes } of page.data) {
                if (attributes.instance === id) publish(attributes.message);
            }
            if (page.meta?.next_token) query.set('next_token', page.meta.next_token);
            else if (page.data.length) return;
            await delay(1500, undefined, { signal });
        }
    }
}
