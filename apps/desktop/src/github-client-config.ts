/** Public OAuth configuration only. Registration and device-flow enablement are owner actions. */
export function validateGithubClientId(value: string | undefined): string {
  if (!value || !/^[A-Za-z0-9_.-]{6,100}$/.test(value)) {
    throw new Error('Set PROPR_DESKTOP_GITHUB_CLIENT_ID to the public ID of the ProPR-owned device-flow OAuth app before packaging.');
  }
  return value;
}

export function resolveGithubClientId(packaged: boolean, built: string | undefined, environment: string | undefined): string | undefined {
  return packaged ? validateGithubClientId(built) : environment;
}
