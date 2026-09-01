export const WINDOWS_INSTALLER_PRODUCT_VERSION_ERROR =
  'Windows MSI ProductVersion must use three numeric components with major and minor at most 255 and patch at most 65535';

const WINDOWS_INSTALLER_PRODUCT_VERSION_PATTERN =
  /^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,4})$/;

export const assertWindowsInstallerProductVersion = version => {
  const match = typeof version === 'string'
    ? WINDOWS_INSTALLER_PRODUCT_VERSION_PATTERN.exec(version)
    : null;
  if (!match
    || Number(match[1]) > 255
    || Number(match[2]) > 255
    || Number(match[3]) > 65535) {
    throw new Error(WINDOWS_INSTALLER_PRODUCT_VERSION_ERROR);
  }
  return version;
};
