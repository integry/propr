export const MACOS_LINUX_RELEASE_PROFILE = 'macos-linux-v1';
export const WINDOWS_INCLUSIVE_RELEASE_PROFILE = 'macos-linux-windows-v1';
export const LINUX_PREVIEW_RELEASE_PROFILE = 'linux-preview-v1';
export const MACOS_PREVIEW_RELEASE_PROFILE = 'macos-preview-v1';
// Preview profiles are unsigned validation channels: they never produce trusted
// update metadata and never enter the stable publication helper.
const PREVIEW_RELEASE_PROFILES = new Set([LINUX_PREVIEW_RELEASE_PROFILE, MACOS_PREVIEW_RELEASE_PROFILE]);

const profileEntries = [
  [LINUX_PREVIEW_RELEASE_PROFILE, [
    ['linux-x64', ['deb', 'rpm']],
    ['linux-arm64', ['deb', 'rpm']],
  ]],
  [MACOS_PREVIEW_RELEASE_PROFILE, [
    ['darwin-x64', ['dmg', 'zip']],
    ['darwin-arm64', ['dmg', 'zip']],
  ]],
  [MACOS_LINUX_RELEASE_PROFILE, [
    ['linux-x64', ['deb', 'rpm', 'zip']],
    ['linux-arm64', ['deb', 'rpm', 'zip']],
    ['darwin-x64', ['dmg', 'zip']],
    ['darwin-arm64', ['dmg', 'zip']],
  ]],
  [WINDOWS_INCLUSIVE_RELEASE_PROFILE, [
    ['linux-x64', ['deb', 'rpm', 'zip']],
    ['linux-arm64', ['deb', 'rpm', 'zip']],
    ['darwin-x64', ['dmg', 'zip']],
    ['darwin-arm64', ['dmg', 'zip']],
    ['win32-x64', ['msi']],
    ['win32-arm64', ['msi']],
  ]],
];

const PROFILES = new Map(profileEntries.map(([name, targets]) => [
  name,
  Object.freeze({
    name,
    targets: new Map(targets.map(([target, kinds]) => [target, Object.freeze([...kinds])])),
    artifactCount: targets.reduce((count, [, kinds]) => count + kinds.length, 0),
    windowsIncluded: targets.some(([target]) => target.startsWith('win32-')),
    previewOnly: PREVIEW_RELEASE_PROFILES.has(name),
  }),
]));

export const resolveReleaseProfile = value => {
  if (typeof value !== 'string' || !PROFILES.has(value)) {
    throw new Error(`Unsupported or missing explicit desktop release profile: ${value ?? '<missing>'}`);
  }
  const profile = PROFILES.get(value);
  return Object.freeze({ ...profile, targets: new Map(profile.targets) });
};

export const releaseFileName = (version, platform, arch, kind) => {
  const platformName = platform === 'darwin' ? 'macos' : platform === 'win32' ? 'windows' : 'linux';
  return kind === 'msi'
    ? `ProPR-Desktop-${version}-${platformName}-${arch}-Machine-Setup.msi`
    : `ProPR-Desktop-${version}-${platformName}-${arch}.${kind}`;
};

export const expectedProfileArtifacts = (profile, version) => {
  const expected = new Map();
  for (const [target, kinds] of profile.targets) {
    const [platform, arch] = target.split('-');
    for (const kind of kinds) {
      expected.set(releaseFileName(version, platform, arch, kind), { platform, arch, kind });
    }
  }
  return expected;
};
