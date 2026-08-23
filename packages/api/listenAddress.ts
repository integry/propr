interface ListenAddressEnv {
  DASHBOARD_API_HOST?: string;
  PROPR_CONTAINERIZED?: string;
}

/**
 * Keep direct host executions loopback-only by default. Containerized services
 * must listen on all container interfaces so Docker can publish the port.
 */
export function resolveApiListenHost(env: ListenAddressEnv = process.env): string {
  const configuredHost = env.DASHBOARD_API_HOST?.trim();
  if (configuredHost) return configuredHost;
  return env.PROPR_CONTAINERIZED === '1' ? '0.0.0.0' : '127.0.0.1';
}
