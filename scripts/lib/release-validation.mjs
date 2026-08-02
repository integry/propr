const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export function validateRelease({
  tag,
  expectedVersion,
  packages,
  launcherManifest,
  changelog,
}) {
  const errors = [];
  const root = packages.find((pkg) => pkg.name === "propr");

  if (!root) {
    return ["Root package propr is missing"];
  }

  const version = root.version;
  if (!SEMVER_PATTERN.test(version)) {
    errors.push(`Root package version is not valid release semver: ${version}`);
  }

  for (const pkg of packages.filter((candidate) => candidate.releaseVersioned)) {
    if (pkg.version !== version) {
      errors.push(`${pkg.name} version ${pkg.version} does not match propr ${version}`);
    }
  }

  const cli = packages.find((pkg) => pkg.name === "@propr/cli");
  if (cli?.sharedDependency !== `^${version}`) {
    errors.push(`@propr/cli must depend on @propr/shared@^${version}`);
  }

  if (launcherManifest.version !== version) {
    errors.push(`Launcher manifest version ${launcherManifest.version} does not match propr ${version}`);
  }

  for (const name of ["app", "ui", "docs", "agent"]) {
    const image = launcherManifest.images?.[name];
    if (typeof image !== "string" || !image.endsWith(`:${version}`)) {
      errors.push(`Launcher ${name} image must be pinned to :${version}`);
    }
  }

  if (tag && tag !== `v${version}`) {
    errors.push(`Release tag ${tag} does not match package version v${version}`);
  }

  if (expectedVersion && expectedVersion !== version) {
    errors.push(`Expected version ${expectedVersion} does not match package version ${version}`);
  }

  if (tag) {
    const escapedVersion = version.replaceAll(".", "\\.").replaceAll("-", "\\-");
    const heading = new RegExp(`^## \\[${escapedVersion}\\] - \\d{4}-\\d{2}-\\d{2}$`, "m");
    if (!heading.test(changelog)) {
      errors.push(`CHANGELOG.md needs a dated ## [${version}] release section before tagging`);
    }
  }

  return errors;
}
