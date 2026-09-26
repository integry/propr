import { chmodSync, copyFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export const PACKAGED_NATIVE_AUTHORITY_MODE = 0o755;

export const packagedConnectNativeArtifacts = (platform: string, arch: string): string[] => {
  if (platform === 'darwin' || platform === 'mas') {
    return [
      `${platform === 'mas' ? 'darwin' : platform}-${arch}/directory-operations.node`,
      `${platform === 'mas' ? 'darwin' : platform}-${arch}/connect-authority-broker`,
    ];
  }
  if (platform === 'linux') return [`linux-${arch}/directory-operations.node`];
  return [];
};

export const copyPackagedNativeAuthority = ({
  arch,
  platform,
  resourcesPath,
  sourceRoot,
}: {
  arch: string;
  platform: string;
  resourcesPath: string;
  sourceRoot: string;
}): string[] => packagedConnectNativeArtifacts(platform, arch).map(relativeArtifact => {
  const target = resolve(resourcesPath, '.vite/native/prebuilds', relativeArtifact);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(resolve(sourceRoot, relativeArtifact), target);

  // Native authority inputs may come from a group-writable source checkout and
  // copyFileSync preserves an existing generated target's mode. Give every
  // packaged Unix authority binary one explicit, executable, non-writable mode
  // before asar and the platform makers copy it into their final payloads.
  chmodSync(target, PACKAGED_NATIVE_AUTHORITY_MODE);
  return target;
});
