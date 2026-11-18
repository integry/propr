import semver from "semver";

function isCanonicalSemVer(version) {
  const parsed = semver.parse(version);
  if (!parsed) return false;
  const canonical = `${parsed.version}${parsed.build.length > 0 ? `+${parsed.build.join(".")}` : ""}`;
  return canonical === version;
}

const RELEASE_IMAGE_REPOSITORIES = {
  app: "propr/app",
  ui: "propr/ui",
  docs: "propr/docs",
  agent: "propr/agent",
};

export function validateRelease({
  tag,
  expectedVersion,
  releaseCandidate = false,
  packages,
  externalInternalDependencies = [],
  launcherManifest,
  changelog,
  releaseNotes,
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
  const allowedExternalInternalDependencies = new Set(externalInternalDependencies);
  for (const pkg of packages) {
    for (const [dependencyName, dependencyRange] of Object.entries(pkg.internalDependencies ?? {})) {
      const dependency = releasePackages.get(dependencyName);
      if (!dependency) {
        if (!allowedExternalInternalDependencies.has(dependencyName)) {
          errors.push(`${pkg.name} depends on undiscovered internal package ${dependencyName}; add its workspace or explicitly allowlist it`);
        }
        continue;
      }
      const expectedRange = `^${dependency.version}`;
      if (dependencyRange !== expectedRange) {
        errors.push(`${pkg.name} must depend on ${dependencyName}@${expectedRange}; found ${dependencyRange}`);
      }
    }
  }

  if (launcherManifest.version !== version) {
    errors.push(`Launcher manifest version ${launcherManifest.version} does not match propr ${version}`);
  }

  for (const [name, repository] of Object.entries(RELEASE_IMAGE_REPOSITORIES)) {
    const image = launcherManifest.images?.[name];
    if (typeof image !== "string" || !image.endsWith(`:${version}`)) {
      errors.push(`Launcher ${name} image must be pinned to :${version}`);
    } else if (image !== `${repository}:${version}`) {
      errors.push(`Launcher ${name} image must use the ${repository} image repository`);
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
    errors.push(...validateReleaseNotes(version, releaseNotes));
  }

  return errors;
}

export const releaseNotesPath = (version) => `release-notes/v${version}.md`;

const RELEASE_NOTES_SECTIONS = ["Highlights", "Upgrade notes"];

// Template markers and unfinished-text conventions that must not reach a
// published release: TODO/TBD/FIXME/XXX, HTML comments left from a template,
// <angle-bracket> or {{mustache}} slots, and filler text.
const RELEASE_NOTES_PLACEHOLDERS = [
  /\b(?:TODO|TBD|FIXME|XXX)\b/,
  /<!--/,
  /<(?!https?:\/\/)[A-Za-z][\w .-]*>/,
  /\{\{[^}]*\}\}/,
  /\blorem ipsum\b/i,
];

export function validateReleaseNotes(version, releaseNotes) {
  const path = releaseNotesPath(version);
  if (typeof releaseNotes !== "string") {
    return [`${path} is missing; write the release summary before release validation`];
  }
  if (releaseNotes.trim() === "") {
    return [`${path} is empty`];
  }

  const errors = [];
  const headings = [...releaseNotes.matchAll(/^## +(.+?)\s*$/gm)].map((match) => ({
    title: match[1],
    start: match.index,
    bodyStart: match.index + match[0].length,
  }));
  let previousIndex = -1;
  for (const section of RELEASE_NOTES_SECTIONS) {
    const index = headings.findIndex((heading) => heading.title === section);
    if (index === -1) {
      errors.push(`${path} needs a ## ${section} section`);
      continue;
    }
    if (index < previousIndex) {
      errors.push(`${path} must put ## ${section} after ## ${RELEASE_NOTES_SECTIONS[0]}`);
    }
    previousIndex = index;
    const end = headings[index + 1]?.start ?? releaseNotes.length;
    if (releaseNotes.slice(headings[index].bodyStart, end).trim() === "") {
      errors.push(`${path} has an empty ## ${section} section (write "None." when there is nothing to say)`);
    }
  }

  const placeholder = RELEASE_NOTES_PLACEHOLDERS
    .map((pattern) => releaseNotes.match(pattern))
    .find(Boolean);
  if (placeholder) {
    errors.push(`${path} still contains a placeholder: ${placeholder[0]}`);
  }

  for (const link of [
    `https://github.com/integry/propr/blob/v${version}/CHANGELOG.md`,
    `https://propr.dev/whats-new/${version}/`,
  ]) {
    if (!releaseNotes.includes(link)) {
      errors.push(`${path} must link to ${link}`);
    }
  }

  return errors;
}
