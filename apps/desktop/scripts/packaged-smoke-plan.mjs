export const READY_EVENT = 'desktop.renderer.ready';
export const PRELOAD_BRIDGE_PROOF = '"preloadBridgeExposed":true';
export const PROFILE_API_PROOF = 'desktop.renderer.profile_api.ready';
export const TRANSPORT_PROOF = 'desktop.renderer.transport_smoke.ready';
export const MVP_FLOWS_PROOF = 'desktop.renderer.mvp_flows.ready';
export const LAYOUT_READY_EVENT = 'desktop.renderer.layout.ready';
export const REDUCED_NATIVE_WINDOW_READY_EVENT = 'desktop.native.reduced_window.ready';
export const CONNECT_DEEP_LINK = 'propr://connect?api=https%3A%2F%2Fconnect.propr.dev';

export const PACKAGED_SMOKE_LAUNCH_MODES = Object.freeze([
  'release-guard',
  'success',
  'retry',
  'forced-timeout',
]);

export const TRANSPORT_SMOKE_ENVIRONMENT_NAMES = Object.freeze([
  'PROPR_DESKTOP_SMOKE_FIRST_ORIGIN',
  'PROPR_DESKTOP_SMOKE_SECOND_ORIGIN',
  'PROPR_DESKTOP_SMOKE_SHUTDOWN_MODE',
]);

const releaseGuardMarkers = Object.freeze([
  READY_EVENT,
  PRELOAD_BRIDGE_PROOF,
  PROFILE_API_PROOF,
  MVP_FLOWS_PROOF,
  LAYOUT_READY_EVENT,
  REDUCED_NATIVE_WINDOW_READY_EVENT,
]);
const transportMarkers = Object.freeze([
  READY_EVENT,
  PRELOAD_BRIDGE_PROOF,
  TRANSPORT_PROOF,
  MVP_FLOWS_PROOF,
  LAYOUT_READY_EVENT,
  REDUCED_NATIVE_WINDOW_READY_EVENT,
]);

export const createPackagedSmokeLaunch = ({
  mode,
  platform,
  userDataPath,
  baseChildEnvironment,
  firstOrigin,
  secondOrigin,
  dbusSessionAddress,
}) => {
  if (!PACKAGED_SMOKE_LAUNCH_MODES.includes(mode)) {
    throw new Error(`Unknown packaged smoke launch mode: ${mode}`);
  }
  const transport = mode !== 'release-guard';
  for (const name of TRANSPORT_SMOKE_ENVIRONMENT_NAMES) {
    if (Object.hasOwn(baseChildEnvironment, name)) {
      throw new Error(`Packaged smoke base environment unexpectedly contains ${name}`);
    }
  }

  const launchArguments = [
    '--disable-gpu',
    '--propr-smoke-test',
    `--user-data-dir=${userDataPath}`,
    ...(transport && platform === 'linux' ? ['--password-store=gnome-libsecret'] : []),
    ...(!transport ? [CONNECT_DEEP_LINK] : []),
  ];
  const childEnvironment = {
    ...baseChildEnvironment,
    ...(transport && platform === 'linux' ? { DBUS_SESSION_BUS_ADDRESS: dbusSessionAddress } : {}),
    ...(transport ? {
      PROPR_DESKTOP_SMOKE_FIRST_ORIGIN: firstOrigin,
      PROPR_DESKTOP_SMOKE_SECOND_ORIGIN: secondOrigin,
      PROPR_DESKTOP_SMOKE_SHUTDOWN_MODE: mode,
    } : {}),
  };

  return Object.freeze({
    mode,
    transport,
    launchArguments: Object.freeze(launchArguments),
    childEnvironment: Object.freeze(childEnvironment),
    requiredMarkers: transport ? transportMarkers : releaseGuardMarkers,
  });
};
