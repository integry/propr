import { execFile } from 'node:child_process';
import os from 'node:os';

/** The process that published a storage claim. */
export interface ClaimOwner {
  /** os.hostname(): the container ID for a default Docker container. */
  host: string;
  pid: number;
  /** Wall-clock start of the owning process, in milliseconds. */
  startedAt: number;
}

const PROCESS_STARTED_AT = Math.round(Date.now() - process.uptime() * 1000);
/** Clock skew between a container's start and its processes' own start estimate. */
const START_SLACK_MS = 5_000;
const CONTAINER_HOST = /^[0-9a-f]{12}$/;

export function currentClaimOwner(): ClaimOwner {
  return { host: os.hostname(), pid: process.pid, startedAt: PROCESS_STARTED_AT };
}

export function isClaimOwner(value: unknown): value is ClaimOwner {
  const owner = value as Partial<ClaimOwner> | null;
  return !!owner && typeof owner.host === 'string' && owner.host.length > 0
    && Number.isSafeInteger(owner.pid) && owner.pid! > 0 && Number.isSafeInteger(owner.startedAt);
}

/**
 * When Docker started the container named by `host`: null when Docker reports
 * no such container, undefined when that cannot be established.
 */
export function dockerContainerStartedAt(host: string): Promise<number | null | undefined> {
  if (!CONTAINER_HOST.test(host)) return Promise.resolve(undefined);
  return new Promise(resolve => {
    execFile('docker', ['inspect', '--type', 'container', '--format', '{{.State.Running}} {{.State.StartedAt}}', host], { timeout: 10_000 }, (error, stdout, stderr) => {
      if (error) return resolve(/no such (object|container)/i.test(`${stderr}`) ? null : undefined);
      const [running, startedAt] = stdout.trim().split(' ');
      if (running !== 'true') return resolve(null);
      const time = Date.parse(startedAt);
      resolve(Number.isFinite(time) ? time : undefined);
    });
  });
}

export interface ClaimOwnerProbe {
  hostname(): string;
  /** Whether `pid` exists in this process's PID namespace. */
  pidExists(pid: number): boolean;
  containerStartedAt(host: string): Promise<number | null | undefined>;
}

export const systemClaimOwnerProbe: ClaimOwnerProbe = {
  hostname: () => os.hostname(),
  pidExists(pid) {
    try { process.kill(pid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
  },
  containerStartedAt: dockerContainerStartedAt,
};

/**
 * Whether a claim's owner is provably gone. A claim is protective, so anything
 * short of proof keeps it: its container was removed or restarted after the
 * owner started, or, in this same container, its PID no longer exists.
 */
export async function claimOwnerGone(owner: ClaimOwner, probe: ClaimOwnerProbe = systemClaimOwnerProbe): Promise<boolean> {
  const started = await probe.containerStartedAt(owner.host);
  if (started === null) return true;
  if (started !== undefined && started > owner.startedAt + START_SLACK_MS) return true;
  if (owner.host === probe.hostname() && started !== undefined) return !probe.pidExists(owner.pid);
  return false;
}
