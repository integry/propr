export interface DesktopRuntimeManifestExpected {
  sourceRevision?: string;
  apiCompatibility?: string;
  distribution?: 'local' | 'published';
}

export interface DesktopRuntimeManifest {
  version: string;
  git_sha: string;
  images: Record<string, string> & { app: string; ui: string };
  desktopRuntime: {
    schemaVersion: 1;
    distribution: 'local' | 'published';
    sourceRevision: string;
    apiCompatibility: string;
    desktopAuthenticationProtocol: 2;
  };
  [key: string]: unknown;
}

export const DESKTOP_RUNTIME_MANIFEST_MODE: number;
export function normalizeDesktopRuntimeManifestMode(path: string): void;
export function writeDesktopRuntimeManifest(path: string, manifest: unknown): void;

export function validateDesktopRuntimeManifest(
  value: unknown,
  expected?: DesktopRuntimeManifestExpected,
): DesktopRuntimeManifest;
export function readDesktopRuntimeManifest(
  path: string,
  expected?: DesktopRuntimeManifestExpected,
): DesktopRuntimeManifest;
export function createDesktopRuntimeManifest(
  base: Record<string, unknown>,
  options: DesktopRuntimeManifestExpected & {
    distribution: 'local' | 'published';
    sourceRevision: string;
    appImage: string;
    uiImage: string;
    apiCompatibility: string;
  },
): DesktopRuntimeManifest;
