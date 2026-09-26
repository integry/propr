export const createPackagedConnectLaunchArguments = ({ platform, userDataPath }) => Object.freeze([
  '--disable-gpu',
  `--user-data-dir=${userDataPath}`,
  ...(platform === 'linux' ? ['--password-store=gnome-libsecret'] : []),
]);

/** Keep the tested lifecycle argv identical at the real packaged-binary spawn boundary. */
export const spawnPackagedConnectBinary = ({
  binaryPath,
  launchArguments,
  options,
  spawn,
}) => spawn(binaryPath, launchArguments, options);
