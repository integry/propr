import semver from "semver";

function isCanonicalSemVer(version) {
  const parsed = semver.parse(version);
  if (!parsed) return false;
  const canonical = `${parsed.version}${parsed.build.length > 0 ? `+${parsed.build.join(".")}` : ""}`;
  return canonical === version;
}

const RELEASE_IMAGE_NAMES = ["app", "ui", "docs", "agent"];

function getImageBasename(image) {
  const lastSlash = image.lastIndexOf("/");
  const lastColon = image.lastIndexOf(":");
  if (lastColon <= lastSlash) return "";
  return image.slice(lastSlash + 1, lastColon);
}

export function validateRelease({
  tag,
  expectedVersion,
  releaseCandidate = false,
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
  if (!isCanonicalSemVer(version)) {
    errors.push(`Root package version is not valid release semver: ${version}`);
  } else {
    const parsedVersion = semver.parse(version);
    if (parsedVersion?.prerelease.length) {
      errors.push(`Release version must not contain prerelease identifiers: ${version}`);
    }
    if (parsedVersion?.build.length) {
      errors.push(`Release version must not contain build metadata: ${version}`);
    }
  }

  for (const pkg of packages.filter((candidate) => candidate.releaseVersioned)) {
    if (pkg.version !== version) {
      errors.push(`${pkg.name} version ${pkg.version} does not match propr ${version}`);
    }
  }

  const releasePackages = new Map(packages.map((pkg) => [pkg.name, pkg]));
  for (const pkg of packages) {
    for (const [dependencyName, dependencyRange] of Object.entries(pkg.internalDependencies ?? {})) {
      const dependency = releasePackages.get(dependencyName);
      if (!dependency) continue;
      const expectedRange = `^${dependency.version}`;
      if (dependencyRange !== expectedRange) {
        errors.push(`${pkg.name} must depend on ${dependencyName}@${expectedRange}; found ${dependencyRange}`);
      }
    }
  }

  if (launcherManifest.version !== version) {
    errors.push(`Launcher manifest version ${launcherManifest.version} does not match propr ${version}`);
  }

  for (const name of RELEASE_IMAGE_NAMES) {
    const image = launcherManifest.images?.[name];
    if (typeof image !== "string" || !image.endsWith(`:${version}`)) {
      errors.push(`Launcher ${name} image must be pinned to :${version}`);
    } else if (getImageBasename(image) !== name) {
      errors.push(`Launcher ${name} image must use the ${name} image repository`);
    }
  }

  if (tag && tag !== `v${version}`) {
    errors.push(`Release tag ${tag} does not match package version v${version}`);
  }

  if (expectedVersion && expectedVersion !== version) {
    errors.push(`Expected version ${expectedVersion} does not match package version ${version}`);
  }

  if (tag || releaseCandidate) {
    const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const heading = new RegExp(`^## \\[${escapedVersion}\\] - \\d{4}-\\d{2}-\\d{2}$`, "m");
    if (!heading.test(changelog)) {
      errors.push(`CHANGELOG.md needs a dated ## [${version}] release section before release validation`);
    }
  }

  return errors;
}
