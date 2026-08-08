import { execFileSync } from 'child_process';

/** Docker-generated IDs and ProPR container names are safe positional CLI arguments. */
const DOCKER_CONTAINER_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export function isValidDockerContainerReference(value: string): boolean {
  return DOCKER_CONTAINER_REFERENCE_PATTERN.test(value);
}

function assertValidDockerContainerReference(value: string): void {
  if (!isValidDockerContainerReference(value)) {
    throw new Error('Invalid Docker container reference in worker state');
  }
}

export function getDockerContainerLogs(containerId: string, tail: number): string {
  assertValidDockerContainerReference(containerId);
  return execFileSync('docker', ['logs', '--tail', String(tail), containerId], {
    encoding: 'utf8',
    timeout: 10000,
    maxBuffer: 10 * 1024 * 1024
  });
}

export function getDockerContainerStatus(containerId: string): string {
  assertValidDockerContainerReference(containerId);
  return execFileSync('docker', ['ps', '-a', '--filter', `id=${containerId}`, '--format', '{{.Status}}'], {
    encoding: 'utf8',
    timeout: 5000
  }).trim();
}
