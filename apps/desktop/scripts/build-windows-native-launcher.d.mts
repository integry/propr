export const WINDOWS_NATIVE_LAUNCHER_SOURCE_DIRECTORY: string;
export const WINDOWS_NATIVE_LAUNCHER: string;
export const WINDOWS_NATIVE_BOOTSTRAP: string;
export const WINDOWS_NATIVE_AUTHORITY_DIRECTORY: string;

export function prepareWindowsAuthorityBuildDirectory(root?: string): Promise<void>;
export function sealWindowsAuthorityDirectory(root?: string): Promise<void>;

export function inspectWindowsNativeLauncherPe(bytes: Buffer, expectedArchitecture: string): {
  format: 'PE';
  architecture: string;
  machine: 'ARM64' | 'AMD64';
};

export function buildWindowsNativeLauncher(): Promise<Record<string, unknown>>;
