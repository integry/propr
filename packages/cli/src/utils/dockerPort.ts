/**
 * Extract the host port from a Docker publish value. The launcher accepts both
 * a bare port (`4000`) and loopback-bound forms (`127.0.0.1:4000`,
 * `[::1]:4000`); CLI-originated local URLs must use only the trailing port.
 */
export function dockerPublishedHostPort(binding: string | number): string {
  const raw = String(binding).trim();
  const match = raw.match(/(?:^|:)(\d{1,5})$/);
  const port = match?.[1];
  const numeric = port ? Number(port) : NaN;
  if (!port || !Number.isInteger(numeric) || numeric < 1 || numeric > 65_535) {
    throw new Error(`invalid Docker published port: ${raw}`);
  }
  return port;
}

export function localhostServiceUrl(binding: string | number): string {
  return `http://localhost:${dockerPublishedHostPort(binding)}`;
}
