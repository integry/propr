import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import logger from '../../../utils/logger.js';
import {
    assertRemoteLoginPath, parseRemoteFileReply, REMOTE_FILE_READ_SCRIPT, REMOTE_LOGIN_HOME, REMOTE_LOGIN_SLOT_WAIT_MS, remoteLoginEnvironment,
    RemoteLoginCapacityError, shellQuote, type RemoteLoginProcess, type RemoteLoginRequest,
} from '../remoteLogin.js';
import type { MachineLaunch, MachinesApi } from './api.js';
import { FlyMachineSlot } from './capacity.js';
import type { FlyConfig } from './config.js';
import { machineLimitRefusal } from './machineLimit.js';

/** Login Machines are named apart from agent (`propr-<uuid>`) and build (`propr-build-`) Machines. */
export const FLY_LOGIN_PREFIX = 'propr-login-';
/** Where the relay keeps the terminal transcript, the input FIFO and the exit status. */
export const FLY_LOGIN_DIR = '/run/propr-login';
/** The login CLI is killed after this long even if ProPR never comes back to destroy the Machine. */
const LOGIN_HARD_LIMIT_SECONDS = 20 * 60;
/** After the CLI exits the Machine waits this long for the credential copy, then stops (and auto-destroys). */
const COLLECT_WINDOW_SECONDS = 15 * 60;
const OUTPUT_CHUNK_BYTES = 48 * 1024;
const FLY_LOGIN_PATH = `${REMOTE_LOGIN_HOME}/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;
const LIVE_STATES = new Set(['created', 'starting', 'started', 'stopping', 'stopped', 'suspending', 'suspended', 'replacing', 'updating']);

export interface FlyLoginOptions {
    pollMs?: number;
    slotWaitMs?: number;
    /** Consecutive failed polls tolerated once the Machine answered (before that, `config.bootTimeout` applies). */
    maxPollFailures?: number;
}

/**
 * The Machine's process: the login CLI under `script` (a PTY, transcript in
 * `out`), reading keystrokes from a FIFO that the shell holds open so the CLI
 * never sees EOF between inputs. The worker reads the transcript and writes
 * input through the Machines exec API; Machines have no interactive console
 * over the public API.
 */
export function flyLoginRelayScript(request: Pick<RemoteLoginRequest, 'command' | 'environment' | 'directories'>): string {
    const directories = request.directories.map(assertRemoteLoginPath);
    const login = ['/usr/local/bin/su-exec', 'node', 'env', '-i', ...remoteLoginEnvironment(request, FLY_LOGIN_PATH), ...request.command]
        .map(shellQuote).join(' ');
    const d = FLY_LOGIN_DIR;
    return [
        'set -u',
        'umask 077',
        `mkdir -p ${d}`,
        `mkfifo ${d}/in`,
        `: > ${d}/out`,
        ...(directories.length ? [`/usr/local/bin/su-exec node mkdir -p -m 700 ${directories.map(shellQuote).join(' ')}`] : []),
        `timeout ${LOGIN_HARD_LIMIT_SECONDS} script -qfec ${shellQuote(login)} ${d}/out < ${d}/in > /dev/null 2>&1 &`,
        'pid=$!',
        `echo "$pid" > ${d}/pid`,
        `exec 3> ${d}/in`,
        'wait "$pid"; code=$?',
        `echo "$code" > ${d}/exit.tmp && mv ${d}/exit.tmp ${d}/exit`,
        'exec 3>&-',
        `sleep ${COLLECT_WINDOW_SECONDS}`,
    ].join('\n');
}

const POLL_SCRIPT = 'if [ -f "$1/exit" ]; then cat "$1/exit"; else echo -; fi; tail -c +"$2" "$1/out" 2>/dev/null | head -c "$3" | base64 -w0';
const INPUT_SCRIPT = 'printf "%s" "$2" > "$1/in"';
const KILL_SCRIPT = 'kill "$(cat "$1/pid")" 2>/dev/null || true';

/** `<exit code or ->\n<base64 chunk>` from {@link POLL_SCRIPT}. */
export function parseFlyLoginPoll(stdout: string): { exitCode?: number; chunk: Buffer } {
    const newline = stdout.indexOf('\n');
    const status = (newline < 0 ? stdout : stdout.slice(0, newline)).trim();
    const encoded = newline < 0 ? '' : stdout.slice(newline + 1).trim();
    const chunk = Buffer.from(encoded, 'base64');
    if (chunk.toString('base64') !== encoded) throw new Error('Invalid Fly login transcript chunk');
    if (status === '-') return { chunk };
    if (!/^\d{1,3}$/.test(status)) throw new Error('Invalid Fly login exit status');
    return { exitCode: Number(status), chunk };
}

async function assertFreeMachine(api: MachinesApi, config: FlyConfig) {
    if (config.maxMachines === undefined || !api.list) return;
    const machines = await api.list('');
    const live = machines.filter(machine => !machine.state || LIVE_STATES.has(machine.state)).length;
    if (live >= config.maxMachines) {
        throw new RemoteLoginCapacityError(`No Fly Machine is free for the login: ${live} of ${config.maxMachines} Machines (PROPR_FLY_MACHINES_MAX) `
            + `exist in app ${config.app}. Wait for a running task to finish and try again.`);
    }
}

/**
 * Runs the provider login CLI on an ephemeral Machine from the agent image. The
 * Machine holds a `PROPR_FLY_MACHINES_MAX` slot like a run and is destroyed
 * when the process is closed; if ProPR never returns, the relay ends the CLI
 * and the Machine stops and auto-destroys.
 */
export async function startFlyLogin(api: MachinesApi, config: FlyConfig, request: RemoteLoginRequest,
    { pollMs = 1000, slotWaitMs = REMOTE_LOGIN_SLOT_WAIT_MS, maxPollFailures = 10 }: FlyLoginOptions = {}): Promise<RemoteLoginProcess> {
    const name = FLY_LOGIN_PREFIX + randomUUID();
    const slot = new FlyMachineSlot(api, config, name, 'agent-login');
    const waitSignal = AbortSignal.any([request.signal, AbortSignal.timeout(slotWaitMs)]);
    try { await slot.acquire(waitSignal); }
    catch (error) {
        request.signal.throwIfAborted();
        throw new RemoteLoginCapacityError(`No Fly Machine is free for the login: all ${config.maxMachines} Machine slots (PROPR_FLY_MACHINES_MAX) `
            + `stayed in use for ${Math.round(slotWaitMs / 1000)}s (${(error as Error)?.name ?? 'timeout'}). Wait for a running task to finish and try again.`);
    }
    let id: string | undefined;
    try {
        await assertFreeMachine(api, config);
        const launch: MachineLaunch = { name, skip_service_registration: true, skip_secrets: true, region: config.region, config: {
            image: config.image, guest: config.guest, metadata: { propr_run_id: name }, auto_destroy: true, restart: { policy: 'no' },
            processes: [{ user: 'root', ignore_app_secrets: true, entrypoint: ['/bin/sh', '-c'], cmd: [flyLoginRelayScript(request)] }], files: [],
        } };
        request.onProgress?.(`Starting a Fly Machine from ${config.image} for the login…`);
        try { id = await slot.create(() => api.create(launch)); }
        catch (error) {
            if (machineLimitRefusal(error)) {
                throw new RemoteLoginCapacityError('Fly refused the login Machine: the organization is at its machine limit (the Free Plan allows 3 Machines). '
                    + 'Wait for a running task to finish, or delete unused Machines, and try again.');
            }
            throw error;
        }
    } catch (error) {
        slot.releaseUndeleted(id);
        throw error;
    }
    const machine = id;
    let closed: Promise<void> | undefined;
    const stopPolling = new AbortController();
    const close = () => closed ??= (async () => {
        stopPolling.abort();
        try { await slot.destroy(machine); }
        catch (error) {
            logger.warn({ app: config.app, machine, err: error }, 'Could not destroy the Fly Machine used for an agent login');
            slot.releaseUndeleted(machine);
        }
    })();
    const listeners: Array<(chunk: string) => void> = [];
    const buffered: string[] = [];
    const decoder = new TextDecoder();
    const emit = (chunk: string) => {
        if (!chunk) return;
        if (listeners.length === 0) buffered.push(chunk);
        else for (const listener of listeners) listener(chunk);
    };
    const exec = (args: string[]) => api.exec(machine, args, stopPolling.signal);
    const exited = (async () => {
        let offset = 0;
        let failures = 0;
        let answered = false;
        const bootDeadline = Date.now() + config.bootTimeout;
        while (!stopPolling.signal.aborted) {
            try {
                const result = await exec(['/bin/sh', '-c', POLL_SCRIPT, 'sh', FLY_LOGIN_DIR, String(offset + 1), String(OUTPUT_CHUNK_BYTES)]);
                if (result.exit_code !== 0) throw new Error(`Fly login poll exited with ${result.exit_code}`);
                const { exitCode, chunk } = parseFlyLoginPoll(result.stdout);
                answered = true;
                failures = 0;
                offset += chunk.length;
                emit(decoder.decode(chunk, { stream: true }));
                if (exitCode !== undefined && chunk.length === 0) {
                    emit(decoder.decode());
                    return exitCode;
                }
                if (chunk.length >= OUTPUT_CHUNK_BYTES) continue;
            } catch (error) {
                if (stopPolling.signal.aborted) break;
                failures++;
                if (answered ? failures > maxPollFailures : Date.now() > bootDeadline) {
                    throw new Error(`Lost the Fly login Machine ${machine}: ${(error as Error).message}`);
                }
            }
            await delay(pollMs, undefined, { signal: stopPolling.signal }).catch(() => {});
        }
        throw new Error('Fly login stopped');
    })();
    exited.catch(() => {});
    let inputs = Promise.resolve();
    return {
        location: `Fly Machine ${machine} in app ${config.app}`,
        onOutput(listener) {
            listeners.push(listener);
            for (const chunk of buffered.splice(0)) listener(chunk);
        },
        write(input) {
            const next = inputs.then(async () => {
                const result = await exec(['timeout', '5', '/bin/sh', '-c', INPUT_SCRIPT, 'sh', FLY_LOGIN_DIR, input]);
                if (result.exit_code !== 0) throw new Error('The login no longer accepts input');
            });
            inputs = next.catch(() => {});
            return next;
        },
        exited,
        kill() { void exec(['/bin/sh', '-c', KILL_SCRIPT, 'sh', FLY_LOGIN_DIR]).catch(() => {}); },
        async readFile(absolutePath) {
            const file = assertRemoteLoginPath(absolutePath);
            const result = await api.exec(machine, ['/bin/sh', '-c', REMOTE_FILE_READ_SCRIPT, 'sh', file]);
            if (result.exit_code !== 0) throw new Error(`Could not read ${file} from the login Machine`);
            return parseRemoteFileReply(result.stdout);
        },
        close,
    };
}
