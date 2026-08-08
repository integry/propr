/** Docker-generated IDs and ProPR container names are safe positional CLI arguments. */
const DOCKER_CONTAINER_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export function isValidDockerContainerReference(value: string): boolean {
  return DOCKER_CONTAINER_REFERENCE_PATTERN.test(value);
}
