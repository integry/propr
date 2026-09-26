import { randomBytes } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, clipboard, crashReporter, dialog, ipcMain, Menu, nativeImage, net, Notification, protocol, safeStorage, screen, session, shell, systemPreferences, Tray } from 'electron';
import type { Rectangle } from 'electron';
import {
  DESKTOP_RENDERER_ORIGIN,
  DESKTOP_TRANSPORT_SCOPE_HEADER,
  PROPR_API_COMPATIBILITY,
  PROPR_UI_COMPATIBILITY,
} from '@propr/shared';
import {
  DESKTOP_CONNECT_DISCOVERY_PLATFORMS,
  discoverConfiguredConnect,
} from '@propr/cli/desktop-discovery';
import { createDesktopSetupHost } from '@propr/cli/desktop-local-setup';
import type { SetupActions } from '@propr/local-setup';
import { launchDesktopAuthentication } from './authentication-handoff';
import { DesktopConnectDiscoveryService } from './connect-discovery';
import { requestDesktopMicrophoneConsent } from './microphone-consent';
import { configureMacOSBranding } from './macos-branding';
import { applicationAboutDetails, showApplicationAbout } from './application-about';
import { configureApplicationMenu } from './application-menu';
import {
  authorizePackagedAcceptanceTest,
  packagedAcceptancePairingTiming,
  packagedAcceptanceAccountConfirmation,
  PACKAGED_ACCEPTANCE_LOOPBACK_ORIGINS,
} from './acceptance-test-authorization';
import { registerPackagedAcceptanceZoomIpc } from './acceptance-zoom';
import { DeepLinkDelivery, deepLinkAcknowledgementTimeoutMs } from './deep-link-delivery';
import { handleDeepLinkDeliveryFailure } from './deep-link-failure-policy';
import { clearDesktopInstanceCookies } from './desktop-session';
import {
  createDesktopNotificationOptions,
  loadDesktopWindowIcon,
  resolveDesktopTrayIconPath,
} from './desktop-icon';
import {
  DesktopCredentialService,
  type DesktopCurrentUserProxyEvidence,
  type DesktopPairingBrowserRequest,
  type DesktopWebSocketHandshakeEvidence,
} from './credential-service';
import {
  registerIpcHandlers,
  type DesktopAcceptanceOperation,
  type DesktopAcceptanceOperationStatus,
} from './ipc';
import { LocalLifecycleController } from './lifecycle';
import { createDesktopLogger, type DesktopLogger } from './logger';
import { NativeNotificationService } from './native-notifications';
import { showElectronNotification } from './notification-show-adapter';
import {
  createDesktopNativeCommandDispatcher,
  type DesktopNativeCommandDispatcher,
} from './native-commands';
import { ProfileStore, type EncryptionProvider } from './profile-store';
import { copyApprovedDesktopPairingUrl, openApprovedDesktopPairingUrl, supportsAmbiguousPairingLaunchRecovery } from './pairing-browser';
import {
  clearPackagedApprovalStorage,
  createPackagedApprovalNavigation,
  createPackagedApprovalTaskTracker,
  packagedApprovalPartition,
} from './packaged-approval-session';
import { assertPackagedConnectProfileIsolation, createPackagedConnectAccountConfirmation } from './packaged-connect-account-confirmation';
import { createDesktopShutdownCoordinator } from './shutdown';
import { createDesktopTrayController } from './system-tray';
import { createMainWindowRestorer } from './main-window-restoration';
import { synchronizeLinuxWindowFrame } from './linux-window-frame';
import { DesktopSetupController } from './setup-controller';
import { promptForWebhookSecret } from './secure-secret-prompt';
import {
  createLatestRendererReloader,
  deepLinkFromArguments,
  hasExactArgument,
  isSafeExternalUrl,
  isTrustedRendererUrl,
  normalizeApiBaseUrl,
  normalizeDeepLink,
  rendererContentSecurityPolicy,
  validatedDevServerUrl,
} from './security';
import {
  DESKTOP_PROTOCOL,
  IPC_CHANNELS,
  type DesktopAcceptanceJourneyStage,
  type DesktopDeepLinkConsumption,
} from './shared/contract';
import { checkForSignedUpdates } from './signed-updates';
import { authorizePackagedSmokeTest } from './smoke-test-authorization';
import { createPackagedSmokeEvidenceSink } from './smoke-test-evidence';
import { configureNativeSmokeLogsPath } from './smoke-log-path';
import {
  configureDesktopSessionSecurity,
  createPackagedConnectOwnershipReporter,
  type DesktopNetworkPermissionEvidence,
  type DesktopRendererOwnershipEvidence,
} from './session-security';
import {
  createBrowserWindowOptions,
  MINIMUM_BROWSER_WINDOW_SIZE,
  selectInitialWindowWorkArea,
} from './window-options';

const devServerUrl = typeof MAIN_WINDOW_VITE_DEV_SERVER_URL === 'string'
  ? MAIN_WINDOW_VITE_DEV_SERVER_URL
  : undefined;
const PACKAGED_RENDERER_SCHEME = 'propr-app';
const PACKAGED_RENDERER_HOST = 'renderer';
const PACKAGED_LAYOUT_READY_EVENT = 'desktop.renderer.layout.ready';
const PACKAGED_REDUCED_NATIVE_WINDOW_READY_EVENT = 'desktop.native.reduced_window.ready';
const PACKAGED_NATIVE_ICON_READY_EVENT = 'desktop.native.icon.ready';
const PACKAGED_CONNECT_DISCOVERY_MILESTONE_EVENT = 'desktop.renderer.connect_discovery.milestone';
const PACKAGED_CONNECT_JOURNEY_STAGE_EVENT = 'desktop.renderer.connect_journey.stage';
const PACKAGED_CONNECT_JOURNEY_FAILURE_EVENT = 'desktop.renderer.connect_journey.failure';
const PACKAGED_CONNECT_JOURNEY_OPERATION_EVENT = 'desktop.renderer.connect_journey.operation';
const PACKAGED_CONNECT_RENDERER_OWNERSHIP_EVENT = 'desktop.renderer.connect_request_ownership';
const NATIVE_COLD_MANUAL_LINK = 'propr://connect?api=http%3A%2F%2Flocalhost%3A44111';
const NATIVE_COLD_TUNNEL_LINK = 'propr://connect?api=https%3A%2F%2Ft-native-relaunch.propr.dev';
const NATIVE_WARM_MANUAL_LINK = 'propr://connect?api=http%3A%2F%2F127.0.0.1%3A44112';
const NATIVE_WARM_TUNNEL_LINK = 'propr://connect?api=https%3A%2F%2Ft-native-evidence.propr.dev';
const NATIVE_WARM_OPEN_LINK = 'propr://open?path=%2Ftasks%3Fstatus%3Dopen';
type NativeSmokePhase = 'first' | 'relaunch';
type PackagedConnectJourneyStage =
  | 'JOURNEY_DISCOVERY_RENDERER'
  | 'JOURNEY_DISCOVERY_VALIDATED'
  | 'JOURNEY_STORAGE_BACKEND'
  | 'JOURNEY_NEGATIVE_MALFORMED'
  | 'JOURNEY_NEGATIVE_OVERSIZED'
  | 'JOURNEY_NEGATIVE_EXPIRY'
  | 'JOURNEY_NEGATIVE_CANCEL'
  | 'JOURNEY_NEGATIVE_STATE'
  | 'JOURNEY_PAIR_MANUAL_FORM'
  | 'JOURNEY_PAIR_BROWSER_APPROVAL'
  | 'JOURNEY_PAIR_ACTIVATION_DASHBOARD'
  | 'JOURNEY_PAIR_AUTHENTICATION_REQUIRED'
  | 'JOURNEY_PAIR_CREDENTIAL_COMMITTED'
  | 'JOURNEY_PAIR_AUTHENTICATED_REPROBE_READY'
  | 'JOURNEY_PAIR_ACTIVATION_COMMITTED'
  | 'JOURNEY_PAIR_ACTIVATION_PUBLISHED'
  | 'JOURNEY_PAIR_REACT_CONNECTED'
  | 'JOURNEY_PAIR_TRANSPORT'
  | 'JOURNEY_PAIR_COMPLETE'
  | 'JOURNEY_REPROBE_ACTIVATION_DASHBOARD'
  | 'JOURNEY_REPROBE_AUTHENTICATED_REPROBE_READY'
  | 'JOURNEY_REPROBE_ACTIVATION_COMMITTED'
  | 'JOURNEY_REPROBE_ACTIVATION_PUBLISHED'
  | 'JOURNEY_REPROBE_REACT_CONNECTED'
  | 'JOURNEY_REPROBE_TRANSPORT'
  | 'JOURNEY_REPROBE_COMPLETE';
type PackagedConnectJourneyFailureReason =
  | 'APPROVAL_REJECTED'
  | 'JOURNEY_FAILED'
  | 'RENDERER_STAGE_TIMEOUT'
  | 'RENDERER_STATE_TIMEOUT'
  | 'TRANSPORT_EVIDENCE_TIMEOUT';
interface PackagedConnectJourneyDiagnosticState {
  phase: 'pair' | 'reprobe';
  stage: PackagedConnectJourneyStage | 'JOURNEY_NOT_STARTED';
}
let packagedConnectJourneyDiagnosticState: PackagedConnectJourneyDiagnosticState | null = null;
const packagedRendererRoot = join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}`);
const packagedRendererUrl = `${DESKTOP_RENDERER_ORIGIN}/renderer.html`;
let packagedSmokeUserDataDirectory: string | null = null;
let packagedAcceptanceUserDataDirectory: string | null = null;
let packagedSmokeEvidence: ReturnType<typeof createPackagedSmokeEvidenceSink> = null;
let nativeSmokePhase: NativeSmokePhase | undefined;
try {
  packagedAcceptanceUserDataDirectory = authorizePackagedAcceptanceTest({
    argv: process.argv,
    defaultUserDataDirectory: join(app.getPath('appData'), app.name),
    environmentTriggered: process.env.PROPR_DESKTOP_ACCEPTANCE_TEST === '1',
    isPackaged: app.isPackaged,
    platform: process.platform,
  });
  packagedSmokeUserDataDirectory = authorizePackagedSmokeTest({
    argv: process.argv,
    defaultUserDataDirectory: join(app.getPath('appData'), app.name),
    environmentTriggered: process.env.PROPR_DESKTOP_SMOKE_TEST === '1',
    isPackaged: app.isPackaged,
    platform: process.platform,
  });
  if (packagedSmokeUserDataDirectory) {
    const requestedNativePhase = process.env.PROPR_DESKTOP_NATIVE_ARTIFACT_PHASE;
    if (requestedNativePhase !== undefined) {
      if (requestedNativePhase !== 'first' && requestedNativePhase !== 'relaunch') {
        throw new Error('Packaged desktop native artifact phase is invalid');
      }
      nativeSmokePhase = requestedNativePhase;
    }
    const smokeDirectoryStats = lstatSync(packagedSmokeUserDataDirectory);
    if (!smokeDirectoryStats.isDirectory() || smokeDirectoryStats.isSymbolicLink()) {
      throw new Error('Packaged desktop smoke --user-data-dir must be an existing non-link directory');
    }
    app.setPath('userData', packagedSmokeUserDataDirectory);
    configureNativeSmokeLogsPath({
      app,
      authorizedNativeSmoke: nativeSmokePhase !== undefined,
      platform: process.platform,
      userDataDirectory: packagedSmokeUserDataDirectory,
    });
    packagedSmokeEvidence = createPackagedSmokeEvidenceSink(packagedSmokeUserDataDirectory, nativeSmokePhase);
    packagedSmokeEvidence?.write('desktop.smoke.authorized');
  }
  if (packagedAcceptanceUserDataDirectory) {
    if (packagedSmokeUserDataDirectory) throw new Error('Desktop test modes are mutually exclusive');
    const acceptanceDirectoryStats = lstatSync(packagedAcceptanceUserDataDirectory);
    if (!acceptanceDirectoryStats.isDirectory() || acceptanceDirectoryStats.isSymbolicLink()) {
      throw new Error('Packaged desktop acceptance --user-data-dir must be an existing non-link directory');
    }
    app.setPath('userData', packagedAcceptanceUserDataDirectory);
  }
} catch {
  process.exit(1);
}
if (process.platform === 'darwin') configureMacOSBranding(app);

const packagedSmokeTest = packagedSmokeUserDataDirectory !== null;
const packagedAcceptanceTest = packagedAcceptanceUserDataDirectory !== null;
const acceptancePairingTiming = packagedAcceptancePairingTiming(packagedAcceptanceUserDataDirectory);
const acceptanceAccountConfirmation = packagedAcceptanceAccountConfirmation(packagedAcceptanceUserDataDirectory);
let mainWindow: BrowserWindow | null = null;
let nativeSmokeWindow: BrowserWindow | null = null;
const initialDeepLink = deepLinkFromArguments(process.argv);
const nativeObservedEvents = new Set<string>();
let nativeRendererReady = false;
let nativeCompletionStarted = false;
let nativeProfiles: ProfileStore | null = null;
let logger: DesktopLogger | null = null;
let shutdownStarted = false;
let desktopNativeCommands: DesktopNativeCommandDispatcher | null = null;
const desktopWindowIcon = loadDesktopWindowIcon({
  platform: process.platform,
  isPackaged: app.isPackaged,
  mainBundleDirectory: __dirname,
  resourcesPath: process.resourcesPath,
  nativeImage,
});
if (process.platform === 'win32') {
  app.setAppUserModelId('dev.propr.desktop');
}

interface PackagedTransportSmoke {
  firstOrigin: string;
  secondOrigin: string;
  shutdownMode: 'success' | 'retry' | 'forced-timeout';
}
let activePackagedTransportSmoke: PackagedTransportSmoke | null = null;
let activePackagedConnectJourney = false;

interface PackagedConnectSmoke {
  configRoot: string;
  fetch: typeof globalThis.fetch;
  journeyEndpoint?: string;
  journeyPhase?: 'pair' | 'reprobe';
}

const packagedConnectSmoke = (): PackagedConnectSmoke | null => {
  if (!app.isPackaged || process.env.PROPR_DESKTOP_CONNECT_SMOKE_TEST !== '1') return null;
  const suppliedRoot = process.env.PROPR_DESKTOP_CONNECT_SMOKE_CONFIG_ROOT;
  if (!suppliedRoot || !isAbsolute(suppliedRoot)) throw new Error('Packaged Connect smoke requires an isolated config root');
  const configRoot = realpathSync.native(suppliedRoot);
  const temporaryRoot = realpathSync.native(app.getPath('temp'));
  const contained = relative(temporaryRoot, configRoot);
  if (!contained || contained.startsWith('..') || isAbsolute(contained)) {
    throw new Error('Packaged Connect smoke config root is outside the temporary directory');
  }
  const suppliedJourneyEndpoint = process.env.PROPR_DESKTOP_CONNECT_JOURNEY_ENDPOINT;
  const suppliedJourneyPhase = process.env.PROPR_DESKTOP_CONNECT_JOURNEY_PHASE;
  let journeyEndpoint: string | undefined;
  let journeyPhase: 'pair' | 'reprobe' | undefined;
  if (suppliedJourneyEndpoint !== undefined || suppliedJourneyPhase !== undefined) {
    const normalized = normalizeApiBaseUrl(suppliedJourneyEndpoint ?? '');
    if (!normalized) throw new Error('Packaged Connect journey requires a bounded non-Windows loopback fixture');
    const parsed = new URL(normalized);
    if (process.platform === 'win32' || parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1'
      || (suppliedJourneyPhase !== 'pair' && suppliedJourneyPhase !== 'reprobe')) {
      throw new Error('Packaged Connect journey requires a bounded non-Windows loopback fixture');
    }
    assertPackagedConnectProfileIsolation(configRoot, app.getPath('userData'));
    journeyEndpoint = normalized;
    journeyPhase = suppliedJourneyPhase;
  }
  const endpoint = 'https://t-packaged123.propr.dev';
  const publicInstanceIdentity = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const fetch: typeof globalThis.fetch = async input => {
    if (input.toString() !== `${endpoint}/api/desktop/discovery`) {
      throw new Error('Packaged Connect smoke rejected an unexpected network request');
    }
    return new Response(JSON.stringify({
      schemaVersion: 1,
      product: 'ProPR',
      version: app.getVersion(),
      apiCompatibility: PROPR_API_COMPATIBILITY,
      uiCompatibility: PROPR_UI_COMPATIBILITY,
      canonicalEndpoint: endpoint,
      publicInstanceIdentity,
      desktopAuthentication: {
        protocolVersion: 2,
        browserPairing: true,
        instanceBearerTokens: true,
        socketIoBearerAuthentication: true,
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return { configRoot, fetch, journeyEndpoint, journeyPhase };
};

const packagedTransportSmoke = (): PackagedTransportSmoke | null => {
  if (!app.isPackaged || process.env.PROPR_DESKTOP_SMOKE_TEST !== '1') return null;
  const transportRequested = [
    process.env.PROPR_DESKTOP_SMOKE_FIRST_ORIGIN,
    process.env.PROPR_DESKTOP_SMOKE_SECOND_ORIGIN,
    process.env.PROPR_DESKTOP_SMOKE_SHUTDOWN_MODE,
  ].some(value => value !== undefined);
  if (!transportRequested) return null;
  const firstOrigin = normalizeApiBaseUrl(process.env.PROPR_DESKTOP_SMOKE_FIRST_ORIGIN ?? '');
  const secondOrigin = normalizeApiBaseUrl(process.env.PROPR_DESKTOP_SMOKE_SECOND_ORIGIN ?? '');
  const shutdownMode = process.env.PROPR_DESKTOP_SMOKE_SHUTDOWN_MODE;
  const isolatedUserData = basename(app.getPath('userData')).startsWith('propr-desktop-smoke-');
  const loopback = (origin: string | null): origin is string => origin !== null
    && new URL(origin).hostname === '127.0.0.1';
  if (!isolatedUserData || !loopback(firstOrigin) || !loopback(secondOrigin) || firstOrigin === secondOrigin
    || (shutdownMode !== 'success' && shutdownMode !== 'retry' && shutdownMode !== 'forced-timeout')) {
    throw new Error('Packaged desktop transport smoke requires two distinct loopback fixtures and isolated user data');
  }
  return { firstOrigin, secondOrigin, shutdownMode };
};

const log = (level: 'debug' | 'info' | 'warn' | 'error', event: string, fields?: Record<string, unknown>) => {
  packagedSmokeEvidence?.write(event);
  if (logger) {
    logger.log(level, event, fields);
  } else {
    console.error(JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      event,
      code: fields ? 'DETAIL_REDACTED' : undefined,
    }));
  }
};

const recordNativeEvent = (event: string): void => {
  if (!nativeSmokePhase) return;
  if (event.endsWith('_once') && nativeObservedEvents.has(event)) {
    packagedSmokeEvidence?.write('desktop.app.start_failed');
    app.exit(1);
    return;
  }
  nativeObservedEvents.add(event);
  packagedSmokeEvidence?.write(event);
};

const nativeEventForDeliveredLink = (value: string): string | null => {
  if (nativeSmokePhase === 'first') {
    if (value === NATIVE_COLD_MANUAL_LINK) return 'desktop.deeplink.cold_manual_once';
    if (value === NATIVE_WARM_MANUAL_LINK) return 'desktop.deeplink.warm_manual_once';
    if (value === NATIVE_WARM_TUNNEL_LINK) return 'desktop.deeplink.warm_tunnel_once';
    if (value === NATIVE_WARM_OPEN_LINK) return 'desktop.deeplink.warm_open_once';
  }
  if (nativeSmokePhase === 'relaunch' && value === NATIVE_COLD_TUNNEL_LINK) {
    return 'desktop.deeplink.cold_tunnel_once';
  }
  return null;
};

const assertNativeRendererConsumption = (
  value: string,
  consumption: DesktopDeepLinkConsumption,
  window: BrowserWindow,
): void => {
  const expected = value === NATIVE_COLD_MANUAL_LINK
    ? { kind: 'connect-confirmation', target: 'http://localhost:44111' }
    : value === NATIVE_COLD_TUNNEL_LINK
      ? { kind: 'connect-confirmation', target: 'https://t-native-relaunch.propr.dev' }
      : value === NATIVE_WARM_MANUAL_LINK
        ? { kind: 'connect-confirmation', target: 'http://127.0.0.1:44112' }
        : value === NATIVE_WARM_TUNNEL_LINK
          ? { kind: 'connect-confirmation', target: 'https://t-native-evidence.propr.dev' }
          : value === NATIVE_WARM_OPEN_LINK
            ? { kind: 'open-queued', target: '/tasks?status=open' }
            : null;
  if (!expected) return;
  if (consumption.kind !== expected.kind || consumption.target !== expected.target) {
    throw new Error('Native renderer deep-link acknowledgement did not prove the intended state');
  }
  if (nativeSmokePhase
    && [NATIVE_WARM_MANUAL_LINK, NATIVE_WARM_TUNNEL_LINK, NATIVE_WARM_OPEN_LINK].includes(value)
    && nativeSmokeWindow !== window) {
    throw new Error('Native warm deep link did not reach the already-running renderer');
  }
};

const deepLinkDelivery = new DeepLinkDelivery<BrowserWindow>(
  IPC_CHANNELS.deepLink,
  initialDeepLink ? [initialDeepLink] : [],
  (value, consumption, window) => {
    assertNativeRendererConsumption(value, consumption, window);
    const event = nativeEventForDeliveredLink(value);
    if (event) recordNativeEvent(event);
    maybeCompleteNativeFirstLaunch();
  },
  () => {
    handleDeepLinkDeliveryFailure(nativeSmokePhase !== undefined, {
      exit: code => app.exit(code),
      log,
    });
  },
  Date.now,
  1_000,
  deepLinkAcknowledgementTimeoutMs(nativeSmokePhase !== undefined),
  nativeSmokePhase !== undefined,
);

const runNativeSecureStorageProbe = async (): Promise<void> => {
  if (nativeSmokePhase !== 'first' || !nativeProfiles) return;
  recordNativeEvent('desktop.native.secure_storage_probe.started');
  const storage = nativeProfiles.security();
  const credential = {
    version: 2 as const,
    profileId: 'native-local',
    origin: 'http://localhost:44221',
    publicInstanceIdentity: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    token: `propr_it_${'a'.repeat(43)}`,
  };
  const credentialWrite = await nativeProfiles.writeCredential(credential);
  if (storage.available) {
    const stored = await nativeProfiles.readCredential('native-local');
    if (storage.backend === 'basic_text' || !credentialWrite.stored
      || stored?.token !== credential.token || stored.origin !== credential.origin) {
      throw new Error('Native secure-storage custody probe did not use OS encryption');
    }
    await nativeProfiles.removeCredential('native-local');
    if (await nativeProfiles.readCredential('native-local') !== null) {
      throw new Error('Native secure-storage custody probe cleanup failed');
    }
    const pending = await nativeProfiles.pendingRevocations();
    if (pending.length !== 1 || pending[0].credential.token !== credential.token
      || !await nativeProfiles.completePendingRevocation(
        pending[0].id,
        pending[0].credential,
        pending[0].credentialGeneration,
      )) {
      throw new Error('Native secure-storage custody probe cleanup failed');
    }
  } else if (credentialWrite.stored || await nativeProfiles.readCredential('native-local') !== null) {
    throw new Error('Native secure-storage custody probe allowed plaintext fallback');
  }
  const expectedBackend = process.platform === 'linux' ? 'gnome_libsecret' : 'os-protected';
  if (!storage.available || storage.backend !== expectedBackend) {
    throw new Error('Native artifact did not retain its expected secure-storage custody');
  }
  recordNativeEvent('desktop.native.secure_storage_probe.completed');
  recordNativeEvent('desktop.native.secure_storage_enforced');
};

function maybeCompleteNativeFirstLaunch(): void {
  const required = [
    'desktop.deeplink.cold_manual_once',
    'desktop.deeplink.warm_manual_once',
    'desktop.deeplink.warm_tunnel_once',
    'desktop.deeplink.warm_open_once',
    'desktop.deeplink.rejected_malformed',
    'desktop.deeplink.rejected_oversized',
    'desktop.deeplink.rejected_unsafe_scheme',
  ];
  if (nativeSmokePhase !== 'first' || !nativeRendererReady || nativeCompletionStarted
    || !required.every(event => nativeObservedEvents.has(event)) || !mainWindow || !nativeProfiles) return;
  nativeCompletionStarted = true;
  const window = mainWindow;
  void (async () => {
    const uiRequiresConfirmation = await window.webContents.executeJavaScript(`(async () => {
      const deadline = performance.now() + 2000;
      do {
        const input = Array.from(document.querySelectorAll('label')).find(label =>
          label.textContent?.includes('Instance URL'))?.querySelector('input');
        if (input?.value === 'https://t-native-evidence.propr.dev') return true;
        await new Promise(resolve => setTimeout(resolve, 25));
      } while (performance.now() < deadline);
      return false;
    })()`);
    const stored = await nativeProfiles!.list();
    const deepLinkedEndpoints = new Set([
      'http://localhost:44111',
      'http://127.0.0.1:44112',
      'https://t-native-evidence.propr.dev',
    ]);
    if (!uiRequiresConfirmation || stored.activeProfileId !== 'native-local' || stored.profiles.length !== 2
      || stored.profiles.some(profile => deepLinkedEndpoints.has(profile.apiBaseUrl))) {
      throw new Error('Native deep-link endpoint was trusted without UI confirmation');
    }
    recordNativeEvent('desktop.deeplink.confirmation_required');
    app.quit();
  })().catch(error => {
    log('error', 'desktop.app.start_failed', { error });
    app.exit(1);
  });
}

const recordNativeRejectedArguments = (argv: readonly string[]): void => {
  if (nativeSmokePhase !== 'first') return;
  if (hasExactArgument(argv, 'native-evidence-malformed')) {
    recordNativeEvent('desktop.deeplink.rejected_malformed');
  }
  if (hasExactArgument(argv, 'https://native-evidence.invalid/unsafe')) {
    recordNativeEvent('desktop.deeplink.rejected_unsafe_scheme');
  }
  if (argv.some(value => value.length > 2_048 && value.startsWith('propr://connect?api='))) {
    recordNativeEvent('desktop.deeplink.rejected_oversized');
  }
  maybeCompleteNativeFirstLaunch();
};

const reportPackagedConnectJourneyStage = (
  code: PackagedConnectJourneyStage,
  evidence: { storageBackend: 'gnome_libsecret' | 'os-protected' } | undefined = undefined,
): void => {
  if (packagedConnectJourneyDiagnosticState) packagedConnectJourneyDiagnosticState.stage = code;
  log('info', PACKAGED_CONNECT_JOURNEY_STAGE_EVENT, { code, ...evidence });
};

const packagedConnectJourneyFailureReason = (error: unknown): PackagedConnectJourneyFailureReason => {
  if (!(error instanceof Error)) return 'JOURNEY_FAILED';
  if (error.message === 'Packaged pairing browser approval was rejected') return 'APPROVAL_REJECTED';
  if (error.message === 'Packaged Connect journey renderer stage timed out') {
    return 'RENDERER_STAGE_TIMEOUT';
  }
  if (error.message === 'Packaged Connect journey renderer state timed out') {
    return 'RENDERER_STATE_TIMEOUT';
  }
  if (error.message === 'Packaged Connect authenticated transport proof timed out') {
    return 'TRANSPORT_EVIDENCE_TIMEOUT';
  }
  return 'JOURNEY_FAILED';
};

interface PackagedJourneyStageTracker {
  record(stage: DesktopAcceptanceJourneyStage): void;
  waitFor(stage: DesktopAcceptanceJourneyStage): Promise<void>;
}

const createPackagedJourneyStageTracker = (
  phase: 'pair' | 'reprobe',
): PackagedJourneyStageTracker => {
  const seen = new Set<DesktopAcceptanceJourneyStage>();
  const waiters = new Map<DesktopAcceptanceJourneyStage, Set<() => void>>();
  const stageCodes: Partial<Record<DesktopAcceptanceJourneyStage, PackagedConnectJourneyStage>> = phase === 'pair'
    ? {
        AUTHENTICATION_REQUIRED: 'JOURNEY_PAIR_AUTHENTICATION_REQUIRED',
        CREDENTIAL_COMMITTED: 'JOURNEY_PAIR_CREDENTIAL_COMMITTED',
        AUTHENTICATED_REPROBE_READY: 'JOURNEY_PAIR_AUTHENTICATED_REPROBE_READY',
        ACTIVATION_COMMITTED: 'JOURNEY_PAIR_ACTIVATION_COMMITTED',
        ACTIVATION_PUBLISHED: 'JOURNEY_PAIR_ACTIVATION_PUBLISHED',
        REACT_CONNECTED: 'JOURNEY_PAIR_REACT_CONNECTED',
      }
    : {
        AUTHENTICATED_REPROBE_READY: 'JOURNEY_REPROBE_AUTHENTICATED_REPROBE_READY',
        ACTIVATION_COMMITTED: 'JOURNEY_REPROBE_ACTIVATION_COMMITTED',
        ACTIVATION_PUBLISHED: 'JOURNEY_REPROBE_ACTIVATION_PUBLISHED',
        REACT_CONNECTED: 'JOURNEY_REPROBE_REACT_CONNECTED',
      };
  return {
    record(stage) {
      const code = stageCodes[stage];
      if (!code) throw new Error('Packaged Connect journey reported an invalid phase stage');
      if (seen.has(stage)) return;
      seen.add(stage);
      reportPackagedConnectJourneyStage(code);
      for (const resolveWaiter of waiters.get(stage) ?? []) resolveWaiter();
      waiters.delete(stage);
    },
    waitFor(stage) {
      if (seen.has(stage)) return Promise.resolve();
      return new Promise<void>((resolveStage, rejectStage) => {
        const timer = setTimeout(() => {
          waiters.get(stage)?.delete(resolve);
          rejectStage(new Error('Packaged Connect journey renderer stage timed out'));
        }, 15_000);
        const resolve = () => {
          clearTimeout(timer);
          resolveStage();
        };
        const current = waiters.get(stage) ?? new Set();
        current.add(resolve);
        waiters.set(stage, current);
      });
    },
  };
};

process.on('uncaughtExceptionMonitor', () => {
  log('error', 'desktop.main_process.uncaught_exception', { code: 'UNCAUGHT_EXCEPTION' });
});

protocol.registerSchemesAsPrivileged([{
  scheme: PACKAGED_RENDERER_SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: true,
  },
}]);

const registerProtocolClient = (): void => {
  if (process.defaultApp && process.argv[1]) {
    app.setAsDefaultProtocolClient(DESKTOP_PROTOCOL, process.execPath, [process.argv[1]]);
    return;
  }
  app.setAsDefaultProtocolClient(DESKTOP_PROTOCOL);
};

const deliverDeepLink = (value: string): void => {
  deepLinkDelivery.deliver(value);
};

const configurePackagedRendererProtocol = (
  contentSecurityPolicy: () => string,
): (() => void) => {
  protocol.handle(PACKAGED_RENDERER_SCHEME, async request => {
    const requestUrl = new URL(request.url);
    if (requestUrl.hostname !== PACKAGED_RENDERER_HOST) {
      return new Response(null, { status: 404 });
    }

    let requestedPath: string;
    try {
      requestedPath = decodeURIComponent(requestUrl.pathname).replace(/^\/+/, '');
    } catch {
      return new Response(null, { status: 400 });
    }
    const filePath = resolve(packagedRendererRoot, requestedPath);
    const relativePath = relative(packagedRendererRoot, filePath);
    if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
      return new Response(null, { status: 403 });
    }
    const response = await net.fetch(pathToFileURL(filePath).href);
    if (requestedPath !== 'renderer.html' || !response.ok) return response;

    const packagedPolicy = rendererContentSecurityPolicy();
    const html = await response.text();
    if (!html.includes(packagedPolicy)) {
      return new Response(null, { status: 500 });
    }
    const headers = new Headers(response.headers);
    headers.delete('content-length');
    headers.set('content-type', 'text/html; charset=UTF-8');
    return new Response(html.replace(packagedPolicy, contentSecurityPolicy()), {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  });
  return () => { void protocol.unhandle(PACKAGED_RENDERER_SCHEME); };
};

const openAllowedExternalUrl = async (url: string): Promise<void> => {
  if (shutdownStarted) return;
  if (!isSafeExternalUrl(url)) {
    log('warn', 'desktop.external_url.rejected');
    return;
  }
  await shell.openExternal(url);
};

const inspectPackagedLayout = async (window: BrowserWindow): Promise<Record<string, unknown>> => {
  const rendererLayout = await window.webContents.executeJavaScript(`(async () => {
    const deadline = performance.now() + 5000;
    let elements;
    do {
      const card = document.querySelector('.desktop-welcome-card');
      const connectButton = card?.querySelector('.desktop-choice-button');
      elements = {
        entry: document.querySelector('.desktop-entry'),
        card,
        logo: card?.querySelector('.desktop-brand img'),
        heading: card?.querySelector('.desktop-welcome-copy h1'),
        connectButton,
        connectDescription: connectButton?.querySelector('small'),
      };
      if (Object.values(elements).every(Boolean)) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    } while (performance.now() < deadline);

    const missing = Object.entries(elements).filter(([, element]) => !element).map(([name]) => name);
    if (missing.length > 0) return { missing };
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const rectangle = rect => ({
      bottom: rect.bottom,
      height: rect.height,
      left: rect.left,
      right: rect.right,
      top: rect.top,
      width: rect.width,
    });
    const bounds = element => {
      const rect = element.getBoundingClientRect();
      return {
        bottom: rect.bottom,
        height: rect.height,
        left: rect.left,
        right: rect.right,
        top: rect.top,
        width: rect.width,
      };
    };
    return {
      screen: { height: window.screen.height, width: window.screen.width },
      workArea: { height: window.screen.availHeight, width: window.screen.availWidth },
      viewport: { height: window.innerHeight, width: window.innerWidth },
      chrome: (() => {
        const dragRegion = document.querySelector('.desktop-entry-drag-region');
        const windowControls = document.querySelector('.desktop-window-controls');
        const controlButtons = windowControls ? [...windowControls.querySelectorAll('button')] : [];
        const overlay = navigator.windowControlsOverlay;
        return {
          dragRegion: dragRegion ? bounds(dragRegion) : null,
          dragRegionStyle: dragRegion ? getComputedStyle(dragRegion).getPropertyValue('-webkit-app-region') : null,
          legacyTitleRowCount: document.querySelectorAll('.desktop-native-titlebar').length,
          nativeControlLabels: controlButtons.map(button => button.getAttribute('aria-label')),
          nativeControlRegion: windowControls ? bounds(windowControls) : null,
          nativeControlRegionStyle: windowControls
            ? getComputedStyle(windowControls).getPropertyValue('-webkit-app-region')
            : null,
          overlayRect: overlay?.getTitlebarAreaRect ? rectangle(overlay.getTitlebarAreaRect()) : null,
          overlayVisible: overlay?.visible ?? false,
        };
      })(),
      ...Object.fromEntries(Object.entries(elements).map(([name, element]) => [name, bounds(element)])),
    };
  })()`);
  const windowBounds = window.getBounds();
  const [minimumWidth, minimumHeight] = window.getMinimumSize();
  return {
    ...rendererLayout,
    windowBounds,
    contentBounds: window.getContentBounds(),
    minimumSize: { width: minimumWidth, height: minimumHeight },
    nativeChrome: {
      closable: window.isClosable(),
      maximizable: window.isMaximizable(),
      minimizable: window.isMinimizable(),
      resizable: window.isResizable(),
    },
    workArea: screen.getDisplayMatching(windowBounds).workArea,
  };
};

const closePackagedProfileEditorAndWaitForWelcomeChooser = async (window: BrowserWindow): Promise<void> => {
  const chooserReady = await window.webContents.executeJavaScript(`(async () => {
    const editor = document.querySelector('.desktop-welcome-card form.desktop-profile-form');
    const backButton = editor?.querySelector('button.desktop-back-button');
    if (!(backButton instanceof HTMLButtonElement)) return false;
    backButton.click();

    const deadline = performance.now() + 5000;
    do {
      const card = document.querySelector('.desktop-welcome-card');
      const connectButton = card?.querySelector('.desktop-choice-button');
      const elements = {
        entry: document.querySelector('.desktop-entry'),
        card,
        logo: card?.querySelector('.desktop-brand img'),
        heading: card?.querySelector('.desktop-welcome-copy h1'),
        connectButton,
        connectDescription: connectButton?.querySelector('small'),
      };
      const visiblyReady = Object.values(elements).every(element => {
        if (!(element instanceof HTMLElement)) return false;
        const bounds = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return bounds.width > 0 && bounds.height > 0
          && bounds.right > 0 && bounds.bottom > 0
          && bounds.left < window.innerWidth && bounds.top < window.innerHeight
          && style.display !== 'none' && style.visibility === 'visible' && style.opacity !== '0';
      });
      if (visiblyReady) return true;
      await new Promise(resolve => setTimeout(resolve, 25));
    } while (performance.now() < deadline);
    return false;
  })()`);
  if (chooserReady !== true) {
    throw new Error('Packaged desktop welcome chooser was not restored after the profile flow');
  }
};

const createReducedSmokeWorkArea = (displayWorkArea: Rectangle): Rectangle => {
  const width = Math.min(displayWorkArea.width, MINIMUM_BROWSER_WINDOW_SIZE.width - 80);
  const height = Math.min(displayWorkArea.height, MINIMUM_BROWSER_WINDOW_SIZE.height - 60);
  return {
    x: displayWorkArea.x + Math.floor((displayWorkArea.width - width) / 2),
    y: displayWorkArea.y + Math.floor((displayWorkArea.height - height) / 2),
    width,
    height,
  };
};

const inspectPackagedReducedNativeWindow = (): Record<string, unknown> => {
  const displayWorkArea = selectInitialWindowWorkArea(screen);
  const workArea = createReducedSmokeWorkArea(displayWorkArea);
  const probeWindow = new BrowserWindow(
    createBrowserWindowOptions(
      join(__dirname, 'preload.cjs'),
      false,
      workArea,
      process.platform,
      desktopWindowIcon?.image,
    ),
  );
  try {
    const [minimumWidth, minimumHeight] = probeWindow.getMinimumSize();
    return {
      displayWorkArea,
      workArea,
      windowBounds: probeWindow.getBounds(),
      minimumSize: { width: minimumWidth, height: minimumHeight },
    };
  } finally {
    probeWindow.destroy();
  }
};

const runPackagedConnectDiscoverySmoke = async (window: BrowserWindow): Promise<{
  selectedPlatform: string;
  selectedArch: string;
  authorityMechanism: string;
  rendererSchemaValid: true;
}> => {
  const proof = await window.webContents.executeJavaScript(`(async () => {
    const bridge = window.proprDesktop;
    const metadata = await bridge.app.getMetadata();
    const candidates = await bridge.discovery.discover();
    return { supported: bridge.discovery.supported, metadata, candidates };
  })()`);
  const candidate = proof?.candidates?.[0];
  if (proof?.supported !== true
    || proof.metadata?.packaged !== true
    || proof.metadata?.platform !== process.platform
    || proof.metadata?.arch !== process.arch
    || !Array.isArray(proof.candidates)
    || proof.candidates.length !== 1
    || !candidate
    || Object.keys(candidate).sort().join(',') !== 'apiBaseUrl,id,label'
    || typeof candidate.id !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(candidate.id)
    || candidate.label !== 'ProPR Connect'
    || candidate.apiBaseUrl !== 'https://t-packaged123.propr.dev') {
    throw new Error('Packaged Connect renderer discovery proof was invalid');
  }
  const readyFields = {
    selectedPlatform: process.platform,
    selectedArch: process.arch,
    authorityMechanism: process.platform === 'darwin'
      ? 'packaged-broker'
      : process.platform === 'linux'
        ? 'in-process-native-addon'
        : 'inherited-standard-handle',
    rendererSchemaValid: true,
  } as const;
  log('info', PACKAGED_CONNECT_DISCOVERY_MILESTONE_EVENT, {
    code: 'JOURNEY_DISCOVERY_VALIDATED',
  });
  return readyFields;
};

const publishPackagedConnectReady = async (readyFields: Awaited<
  ReturnType<typeof runPackagedConnectDiscoverySmoke>
>): Promise<void> => {
  await new Promise<void>((resolveReady, rejectReady) => {
    process.stdout.write(`${JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'info',
      event: 'desktop.renderer.connect_discovery.ready',
      ...readyFields,
    })}\n`, error => {
      if (error) rejectReady(new Error('Packaged Connect READY publication failed'));
      else resolveReady();
    });
  });
};

const openPackagedJourneyApproval = async (request: DesktopPairingBrowserRequest): Promise<void> => {
  reportPackagedConnectJourneyStage('JOURNEY_PAIR_BROWSER_APPROVAL');
  await openApprovedDesktopPairingUrl(request, {
    openExternal: async url => {
      const approvalSession = session.fromPartition(
        packagedApprovalPartition(randomBytes(16).toString('hex')),
        { cache: false },
      );
      let approvalWindow: BrowserWindow | null = null;
      let navigation: ReturnType<typeof createPackagedApprovalNavigation> | null = null;
      try {
        approvalWindow = new BrowserWindow({
          show: false,
          webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            session: approvalSession,
            webSecurity: true,
          },
        });
        navigation = createPackagedApprovalNavigation({
          approvalUrl: url,
          approvalSession,
          approvalWindow,
          defaultSession: session.defaultSession,
        });
        await navigation.navigate();
      } finally {
        if (navigation) {
          await navigation.cleanup();
        } else {
          if (approvalWindow && !approvalWindow.isDestroyed()) approvalWindow.destroy();
          await clearPackagedApprovalStorage(approvalSession);
        }
      }
    },
  });
};

const runPackagedConnectJourneySmoke = async (
  window: BrowserWindow,
  profiles: ProfileStore,
  credentials: DesktopCredentialService,
  waitForNextApproval: () => Promise<void>,
  waitForApprovalIdle: () => Promise<void>,
  endpoint: string,
  phase: 'pair' | 'reprobe',
  stages: PackagedJourneyStageTracker,
): Promise<void> => {
  const security = profiles.security();
  const requiredStorageBackend = process.platform === 'linux' ? 'gnome_libsecret' : 'os-protected';
  if (!security.available || security.backend !== requiredStorageBackend) {
    throw new Error('Packaged Connect journey requires the production OS credential backend');
  }
  reportPackagedConnectJourneyStage('JOURNEY_STORAGE_BACKEND', {
    storageBackend: requiredStorageBackend,
  });
  if (phase === 'pair') {
    const setMode = async (mode: 'success' | 'malformed' | 'oversized' | 'expiry' | 'cancel') => {
      const response = await session.defaultSession.fetch(`${endpoint}/__packaged/control/${mode}`, {
        method: 'POST', redirect: 'manual',
      });
      if (response.status !== 204) throw new Error('Packaged Connect fixture control failed');
    };
    for (const mode of ['malformed', 'oversized'] as const) {
      reportPackagedConnectJourneyStage(mode === 'malformed'
        ? 'JOURNEY_NEGATIVE_MALFORMED'
        : 'JOURNEY_NEGATIVE_OVERSIZED');
      await setMode(mode);
      const result = await credentials.probe({
        id: `negative-${mode}`,
        label: `Packaged ${mode}`,
        apiBaseUrl: endpoint,
      });
      if (result.status === 'ready' || result.status === 'incompatible') {
        throw new Error('Strict packaged discovery accepted invalid identity');
      }
    }
    reportPackagedConnectJourneyStage('JOURNEY_NEGATIVE_EXPIRY');
    await setMode('expiry');
    await credentials.pair({
      id: 'negative-expiry', label: 'Packaged expiry', apiBaseUrl: endpoint,
    }).then(
      () => { throw new Error('Packaged pairing expiry unexpectedly succeeded'); },
      error => {
        if (!(error instanceof Error) || !/expired/i.test(error.message)) {
          throw new Error('Packaged pairing expiry classification failed');
        }
      },
    );
    await waitForApprovalIdle();
    reportPackagedConnectJourneyStage('JOURNEY_NEGATIVE_CANCEL');
    await setMode('cancel');
    const approvalReady = waitForNextApproval();
    const cancelledPairing = credentials.pair({
      id: 'negative-cancel', label: 'Packaged cancel', apiBaseUrl: endpoint,
    });
    await approvalReady;
    await new Promise(resolve => setTimeout(resolve, 50));
    credentials.cancelPairing('negative-cancel');
    await cancelledPairing.then(
      () => { throw new Error('Packaged pairing cancellation unexpectedly succeeded'); },
      error => {
        if (!(error instanceof Error) || !/cancelled/i.test(error.message)) {
          throw new Error('Packaged pairing cancellation classification failed');
        }
      },
    );
    await waitForApprovalIdle();
    reportPackagedConnectJourneyStage('JOURNEY_NEGATIVE_STATE');
    const failedProfiles = await profiles.list();
    if (failedProfiles.profiles.some(profile => profile.id.startsWith('negative-'))) {
      throw new Error('Failed packaged pairing left stale profile or credential state');
    }
    await setMode('success');
  }
  reportPackagedConnectJourneyStage(phase === 'pair'
    ? 'JOURNEY_PAIR_MANUAL_FORM'
    : 'JOURNEY_REPROBE_ACTIVATION_DASHBOARD');
  if (phase === 'pair') {
    const submitted = await window.webContents.executeJavaScript(`(async () => {
    const waitFor = async predicate => {
      const deadline = performance.now() + 15000;
      do {
        const value = predicate();
        if (value) return value;
        await new Promise(resolve => setTimeout(resolve, 25));
      } while (performance.now() < deadline);
      throw new Error('Packaged Connect journey renderer state timed out');
    };
    const setInput = (input, value) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const chooser = await waitFor(() => document.querySelector('.desktop-welcome-card'));
    const connect = Array.from(chooser.querySelectorAll('button.desktop-choice-button'))
      .find(button => button.textContent?.includes('Connect to an existing instance'));
    if (!(connect instanceof HTMLButtonElement)) return false;
    connect.click();
    const form = await waitFor(() => document.querySelector('form.desktop-profile-form'));
    const inputs = form.querySelectorAll('input');
    if (inputs.length !== 2) return false;
    setInput(inputs[0], 'Packaged remote');
    setInput(inputs[1], ${JSON.stringify(endpoint)});
    form.requestSubmit();
    await waitFor(() => Array.from(document.querySelectorAll('.desktop-connection-card button'))
      .find(button => button.textContent?.includes('Sign in in browser')));
    return true;
  })()`);
    if (submitted !== true) throw new Error('Packaged Connect manual profile submission failed');
    await stages.waitFor('AUTHENTICATION_REQUIRED');
    const clicked = await window.webContents.executeJavaScript(`(() => {
      const authenticate = Array.from(document.querySelectorAll('.desktop-connection-card button'))
        .find(button => button.textContent?.includes('Sign in in browser'));
      if (!(authenticate instanceof HTMLButtonElement)) return false;
      authenticate.click();
      return true;
    })()`);
    if (clicked !== true) throw new Error('Packaged Connect authentication action was missing');
    await stages.waitFor('CREDENTIAL_COMMITTED');
  }
  await stages.waitFor('AUTHENTICATED_REPROBE_READY');
  await stages.waitFor('ACTIVATION_COMMITTED');
  await stages.waitFor('ACTIVATION_PUBLISHED');
  await stages.waitFor('REACT_CONNECTED');
  const proof = await window.webContents.executeJavaScript(`(() => {
    const dashboard = document.querySelector('.desktop-app');
    const connection = document.querySelector('.desktop-instance-selector-button.desktop-connection-ready');
    const titlebar = document.querySelector('.desktop-titlebar');
    return {
      connected: dashboard instanceof HTMLElement
        && connection instanceof HTMLButtonElement
        && titlebar === null,
      rendererContractsContainSecret: JSON.stringify([
        window.proprDesktop,
        dashboard instanceof HTMLElement ? dashboard.dataset : null,
      ]).includes('propr_it_'),
      title: connection instanceof HTMLButtonElement ? connection.getAttribute('aria-label') : null,
    };
  })()`);
  if (proof?.connected !== true || proof?.rendererContractsContainSecret !== false
    || !proof?.title?.startsWith('Connected: Packaged remote')) {
    throw new Error('Packaged Connect dashboard did not reach its connected state');
  }
  reportPackagedConnectJourneyStage(phase === 'pair'
    ? 'JOURNEY_PAIR_TRANSPORT'
    : 'JOURNEY_REPROBE_TRANSPORT');
  const requiredAuthenticatedRequests = phase === 'pair' ? 1 : 2;
  const evidenceDeadline = Date.now() + 10_000;
  let transportEvidence = { authenticatedRest: 0, authenticatedSockets: 0 };
  do {
    const response = await session.defaultSession.fetch(`${endpoint}/__packaged/evidence`, {
      credentials: 'omit',
      redirect: 'manual',
    });
    if (response.status !== 200) throw new Error('Packaged Connect transport evidence was unavailable');
    const candidate: unknown = await response.json();
    if (candidate !== null && typeof candidate === 'object') {
      const record = candidate as Record<string, unknown>;
      if (Number.isInteger(record.authenticatedRest) && Number.isInteger(record.authenticatedSockets)) {
        transportEvidence = {
          authenticatedRest: record.authenticatedRest as number,
          authenticatedSockets: record.authenticatedSockets as number,
        };
      }
    }
    if (transportEvidence.authenticatedRest >= requiredAuthenticatedRequests
      && transportEvidence.authenticatedSockets >= requiredAuthenticatedRequests) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  } while (Date.now() < evidenceDeadline);
  if (transportEvidence.authenticatedRest < requiredAuthenticatedRequests
    || transportEvidence.authenticatedSockets < requiredAuthenticatedRequests) {
    throw new Error('Packaged Connect authenticated transport proof timed out');
  }
  await waitForApprovalIdle();
  reportPackagedConnectJourneyStage(phase === 'pair'
    ? 'JOURNEY_PAIR_COMPLETE'
    : 'JOURNEY_REPROBE_COMPLETE');
};

const runPackagedTransportSmoke = async (
  window: BrowserWindow,
  profiles: ProfileStore,
  credentials: DesktopCredentialService,
  smoke: PackagedTransportSmoke,
): Promise<void> => {
  const profileId = 'packaged-transport-smoke';
  const tokenA = `propr_it_${randomBytes(32).toString('base64url')}`;
  const tokenB = `propr_it_${randomBytes(32).toString('base64url')}`;
  const security = profiles.security();
  if (!security.available || security.backend === 'basic_text') {
    throw new Error('Packaged transport smoke requires the production OS credential backend');
  }
  const profileA = await profiles.save({
    id: profileId, label: 'Packaged transport A', apiBaseUrl: smoke.firstOrigin,
  });
  const storedA = await profiles.writeCredential({
    version: 2, profileId, origin: smoke.firstOrigin,
    publicInstanceIdentity: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', token: tokenA,
  });
  if (!storedA.stored) throw new Error('Production credential encryption was unavailable');

  const storageWindows = await Promise.all([smoke.firstOrigin, smoke.secondOrigin].map(async origin => {
    const storageWindow = new BrowserWindow({
      show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true },
    });
    await storageWindow.loadURL(`${origin}/smoke-storage`);
    return { origin, window: storageWindow };
  }));
  const seedStorage = async (): Promise<void> => {
    await Promise.all(storageWindows.map(item => item.window.webContents.executeJavaScript(`(async () => {
        document.cookie = 'packaged-smoke-cookie=present; SameSite=Lax';
        localStorage.setItem('packaged-smoke-local', 'present');
        await new Promise((resolve, reject) => {
          const request = indexedDB.open('packaged-smoke-indexeddb', 1);
          request.onupgradeneeded = () => request.result.createObjectStore('proof');
          request.onsuccess = () => { request.result.close(); resolve(true); };
          request.onerror = () => reject(request.error);
        });
        const cache = await caches.open('packaged-smoke-cache');
        await cache.put('/packaged-smoke-cache-entry', new Response('present'));
        await navigator.serviceWorker.register('/smoke-sw.js');
        await navigator.serviceWorker.ready;
        return true;
      })()`)));
  };
  const storageState = async (expected: 'present' | 'absent'): Promise<boolean> => {
    const states = await Promise.all(storageWindows.map(async item => {
      const rendererState = await item.window.webContents.executeJavaScript(`(async () => ({
        cookie: document.cookie.includes('packaged-smoke-cookie=present'),
        localStorage: localStorage.getItem('packaged-smoke-local') === 'present',
        indexedDB: (await indexedDB.databases()).some(database => database.name === 'packaged-smoke-indexeddb'),
        cacheStorage: (await caches.keys()).includes('packaged-smoke-cache'),
        serviceWorker: (await navigator.serviceWorker.getRegistrations()).some(registration => registration.scope.startsWith(location.origin)),
      }))()`);
      const cookies = await session.defaultSession.cookies.get({ url: item.origin });
      return { ...rendererState, cookie: rendererState.cookie || cookies.length > 0 } as Record<string, boolean>;
    }));
    return states.every(state => Object.values(state).every(value => value === (expected === 'present')));
  };

  try {
    await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const started = Date.now();
      const poll = () => {
        if (window.__proprPackagedTransportSmoke) return resolve(true);
        if (Date.now() - started > 5000) return reject(new Error('Packaged renderer smoke harness timed out'));
        setTimeout(poll, 20);
      };
      poll();
    })`);
    const profileForRendererA = { id: profileId, name: profileA.label, baseUrl: smoke.firstOrigin, kind: 'local' };
    const first = await window.webContents.executeJavaScript(`(async () => {
      const smoke = window.__proprPackagedTransportSmoke;
      const first = await smoke.activate(${JSON.stringify(profileForRendererA)});
      await smoke.rest();
      const socketId = await smoke.connectSocket();
      const rotated = await smoke.activate(${JSON.stringify(profileForRendererA)});
      let staleRestRejected = false;
      try {
        const response = await fetch(${JSON.stringify(smoke.firstOrigin + '/api/smoke/rest')}, {
          headers: { ${JSON.stringify(DESKTOP_TRANSPORT_SCOPE_HEADER)}: first.transportScope },
          credentials: 'include',
        });
        staleRestRejected = !response.ok;
      } catch { staleRestRejected = true; }
      await smoke.expectSocketRejected(socketId);
      await smoke.rest();
      localStorage.setItem('packaged-smoke-local', 'non-secret sentinel');
      sessionStorage.setItem('packaged-smoke-session', 'non-secret sentinel');
      return { first, rotated, socketId, staleRestRejected, rendererOrigin: location.origin };
    })()`);
    if (first?.rendererOrigin !== DESKTOP_RENDERER_ORIGIN || first?.first?.profileId !== profileId
      || first?.first?.transportScope === first?.rotated?.transportScope
      || first?.first?.contractsContainSecret !== false || first?.rotated?.contractsContainSecret !== false
      || first?.staleRestRejected !== true) {
      throw new Error('Packaged renderer protocol or A transport smoke proof failed');
    }
    await seedStorage();
    if (!await storageState('present')) throw new Error('Packaged origin storage fixture was incomplete');

    let cleanupFailed = false;
    try {
      await credentials.saveProfile({
        id: profileId, label: 'Packaged transport B', apiBaseUrl: smoke.secondOrigin,
      }, async () => { throw new Error('packaged cleanup failure'); });
    } catch (error) {
      cleanupFailed = error instanceof Error && error.message === 'packaged cleanup failure';
    }
    const rollback = await profiles.readProfileCredential(profileId);
    if (!cleanupFailed || rollback.profile?.apiBaseUrl !== smoke.firstOrigin
      || rollback.credential?.origin !== smoke.firstOrigin || rollback.credential.token !== tokenA
      || !await storageState('present')) {
      throw new Error('Origin cleanup failure did not preserve complete durable A');
    }
    let precommitStorageCleared = false;
    await credentials.saveProfile({
      id: profileId, label: 'Packaged transport B', apiBaseUrl: smoke.secondOrigin,
    }, async (previousOrigin, nextOrigin) => {
      await clearDesktopInstanceCookies(session.defaultSession, [previousOrigin, nextOrigin]);
      precommitStorageCleared = await storageState('absent');
      if (!precommitStorageCleared) throw new Error('Complete origin storage was not cleared before commit');
    });
    if (!precommitStorageCleared || !await storageState('absent')) {
      throw new Error('Same-ID URL edit did not clear both complete Electron origin stores');
    }
    const storedB = await profiles.writeCredential({
      version: 2, profileId, origin: smoke.secondOrigin,
      publicInstanceIdentity: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', token: tokenB,
    });
    if (!storedB.stored) throw new Error('Replacement credential encryption was unavailable');

    const profileForRendererB = { id: profileId, name: 'Packaged transport B', baseUrl: smoke.secondOrigin, kind: 'local' };
    const second = await window.webContents.executeJavaScript(`(async () => {
      const smoke = window.__proprPackagedTransportSmoke;
      const activated = await smoke.activate(${JSON.stringify(profileForRendererB)});
      const socketId = await smoke.connectSocket();
      await smoke.reconnectSocket(socketId);
      const staleClassification = await smoke.handleStaleInvalidation(
        ${JSON.stringify(profileId)}, ${JSON.stringify(first.rotated.transportScope)}
      );
      smoke.disconnectSocket(${JSON.stringify(first.socketId)});
      await smoke.rest();
      const persisted = await window.proprDesktop.profiles.list();
      const rendererEvidence = smoke.rendererEvidence();
      return {
        activated,
        staleClassification,
        persisted,
        rendererEvidence,
        rendererPersistenceContainsSecret: JSON.stringify([persisted, rendererEvidence]).includes('propr_it_'),
      };
    })()`);
    const secretInMainMetadata = [tokenA, tokenB].some(secret =>
      process.argv.some(argument => argument.includes(secret))
      || JSON.stringify(crashReporter.getParameters()).includes(secret));
    if (second?.staleClassification !== 'retryable' || second?.activated?.profileId !== profileId
      || second?.activated?.contractsContainSecret !== false
      || second?.rendererPersistenceContainsSecret !== false
      || secretInMainMetadata) {
      throw new Error('Packaged replacement scope or secret-custody smoke proof failed');
    }
    log('info', 'desktop.renderer.transport_smoke.ready', {
      customProtocol: true,
      restBearer: true,
      socketIo: true,
      engineIoHandshake: true,
      namespaceAuthentication: true,
      reconnectAndErrorHandling: true,
      scopeRotation: true,
      allOriginStorageCleared: true,
      cleanupRollbackAndRetry: true,
      staleScopeRejected: true,
      secretCustody: true,
      productionCredentialRoundTrip: true,
      storageBackend: security.backend,
    });
  } finally {
    for (const item of storageWindows) {
      if (!item.window.isDestroyed()) item.window.destroy();
    }
  }
};

const createMainWindow = async (
  transportSmoke: PackagedTransportSmoke | null = activePackagedTransportSmoke,
  connectJourney = activePackagedConnectJourney,
): Promise<BrowserWindow> => {
  const workArea = selectInitialWindowWorkArea(screen);
  const window = new BrowserWindow(
    createBrowserWindowOptions(
      join(__dirname, 'preload.cjs'),
      !app.isPackaged,
      workArea,
      process.platform,
      desktopWindowIcon?.image,
    ),
  );
  if (process.platform === 'linux') synchronizeLinuxWindowFrame(window);
  if (process.platform === 'darwin') {
    window.on('page-title-updated', (event, title) => {
      if (title !== 'ProPR Desktop') return;
      event.preventDefault();
      window.setTitle('ProPR');
    });
  }
  if (packagedSmokeTest && desktopWindowIcon) {
    log('info', PACKAGED_NATIVE_ICON_READY_EVENT, {
      asset: basename(desktopWindowIcon.path),
      ...desktopWindowIcon.size,
    });
  }
  const disposeAcceptanceZoomIpc = registerPackagedAcceptanceZoomIpc({
    authorized: packagedAcceptanceTest,
    ipcMain,
    webContents: window.webContents,
  });
  window.once('closed', disposeAcceptanceZoomIpc);
  const readyToShow = new Promise<void>(resolveReady => window.once('ready-to-show', resolveReady));

  window.webContents.setWindowOpenHandler(({ url }) => {
    void openAllowedExternalUrl(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (isTrustedRendererUrl(url, devServerUrl, packagedRendererUrl)) return;
    event.preventDefault();
    void openAllowedExternalUrl(url);
  });
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  window.webContents.on('render-process-gone', (_event, details) => {
    desktopNativeCommands?.rendererUnavailable();
    log('error', 'desktop.renderer.gone', { reason: details.reason, exitCode: details.exitCode });
  });
  window.webContents.on('did-finish-load', () => {
    deepLinkDelivery.didFinishLoad(window);
    desktopNativeCommands?.rendererReady(window);
  });
  window.webContents.on('did-start-navigation', details => {
    if (details.isMainFrame && !details.isSameDocument) {
      desktopNativeCommands?.rendererUnavailable();
      deepLinkDelivery.didStartMainFrameNavigation(window);
    }
  });
  window.webContents.on('did-navigate', () => {
    deepLinkDelivery.didCommitMainFrameNavigation(window);
  });
  window.on('closed', () => {
    desktopNativeCommands?.rendererUnavailable();
    deepLinkDelivery.clearWindow(window);
    if (mainWindow === window) {
      mainWindow = null;
    }
  });

  const validatedDevUrl = validatedDevServerUrl(devServerUrl);
  if (devServerUrl && !validatedDevUrl) throw new Error('Electron Forge supplied an unsafe renderer development URL');
  if (validatedDevUrl) {
    await window.loadURL(new URL('renderer.html', validatedDevUrl).href);
  } else {
    const rendererUrl = new URL(packagedRendererUrl);
    if (transportSmoke) rendererUrl.hash = 'packaged-transport-smoke';
    await window.loadURL(rendererUrl.href);
  }

  await readyToShow;
  const preloadBridgeExposed = await window.webContents.executeJavaScript(
    "typeof window.proprDesktop === 'object' && window.proprDesktop !== null",
  );
  if (preloadBridgeExposed !== true) {
    throw new Error('Desktop preload bridge was not exposed to the renderer');
  }
  if (nativeSmokePhase && !nativeSmokeWindow) nativeSmokeWindow = window;
  deepLinkDelivery.setWindow(window);
  if (nativeSmokePhase) {
    await deepLinkDelivery.whenIdle();
    // The renderer acknowledges a Connect link only from ProfileEditor's layout
    // effect, after the exact untrusted endpoint is committed to the confirmation
    // input. The acknowledgement above is therefore the presentation proof; a
    // second main-process DOM inspection races application teardown after failures.
    if (nativeSmokePhase === 'first') {
      await runNativeSecureStorageProbe();
      recordNativeEvent('desktop.native.profile_fresh');
    } else {
      recordNativeEvent('desktop.native.profile_preserved');
      recordNativeEvent('desktop.deeplink.confirmation_required');
    }
  }
  const smokeProfileApiUrl = process.env.PROPR_DESKTOP_SMOKE_PROFILE_API_URL;
  if (packagedSmokeTest && !transportSmoke && smokeProfileApiUrl) {
    const normalizedSmokeApiUrl = normalizeApiBaseUrl(smokeProfileApiUrl);
    if (!normalizedSmokeApiUrl || normalizedSmokeApiUrl !== smokeProfileApiUrl) {
      throw new Error('Packaged desktop smoke profile API URL is invalid');
    }
    const endpoints = [
      `${normalizedSmokeApiUrl}/api/compatibility`,
      `${normalizedSmokeApiUrl}/api/desktop/discovery`,
    ];
    const result = await window.webContents.executeJavaScript(`(async () => {
      const results = [];
      for (const endpoint of ${JSON.stringify(endpoints)}) {
        const response = await fetch(endpoint, { credentials: 'include' });
        results.push({ ok: response.ok, status: response.status, body: await response.json() });
      }
      return results;
    })()`);
    if (result?.[0]?.ok !== true || result[0]?.body?.profileEndpoint !== true
      || result?.[1]?.ok !== true || result[1]?.body?.product !== 'ProPR'
      || result[1]?.body?.desktopAuthentication?.protocolVersion !== 1) {
      throw new Error('Packaged renderer profile API or ProPR Connect discovery request failed');
    }
    log('info', 'desktop.renderer.profile_api.ready', { origin: DESKTOP_RENDERER_ORIGIN });
  }
  let mvpFlowProof: Record<string, unknown> = { connectDiscovery: true };
  const assertPackagedMvpBoundary = async (): Promise<void> => {
    const boundary = await window.webContents.executeJavaScript(`(async () => {
      const bridge = window.proprDesktop;
      const metadata = await bridge.app.getMetadata();
      const profiles = await bridge.profiles.list();
      const lifecycle = await bridge.lifecycle.start();
      return {
        packaged: metadata.packaged,
        profiles: Array.isArray(profiles.profiles),
        lifecycleBoundary: lifecycle.ok === false && lifecycle.code === 'not-implemented',
      };
    })()`);
    if (!boundary?.packaged || !boundary?.profiles || !boundary?.lifecycleBoundary) {
      throw new Error('Packaged desktop transport smoke did not preserve the MVP bridge boundaries');
    }
  };
  if (packagedSmokeTest && !transportSmoke && !connectJourney) {
    if (nativeSmokePhase) {
      await assertPackagedMvpBoundary();
    } else {
      const profileFlow = await window.webContents.executeJavaScript(`(async () => {
        const bridge = window.proprDesktop;
        const local = await bridge.profiles.save({ label: 'Local setup', apiBaseUrl: 'http://localhost:4000' });
        const remote = await bridge.profiles.save({ label: 'ProPR Connect', apiBaseUrl: 'https://connect.propr.dev' });
        await bridge.profiles.setActive(remote.id);
        const profiles = await bridge.profiles.list();
        const lifecycle = await bridge.lifecycle.start();
        const deadline = performance.now() + 2000;
        let connectDeepLink = false;
        do {
          const labels = Array.from(document.querySelectorAll('.desktop-welcome-card form > label'));
          connectDeepLink = labels[1]?.querySelector('input')?.value === 'https://connect.propr.dev';
          if (connectDeepLink) break;
          await new Promise(resolve => setTimeout(resolve, 25));
        } while (performance.now() < deadline);
        return {
          active: profiles.activeProfileId === remote.id,
          local: profiles.profiles.some(profile => profile.id === local.id && profile.apiBaseUrl === 'http://localhost:4000'),
          remote: profiles.profiles.some(profile => profile.id === remote.id && profile.apiBaseUrl === 'https://connect.propr.dev'),
          lifecycleBoundary: lifecycle.ok === false && lifecycle.code === 'not-implemented',
          connectDeepLink,
        };
      })()`);
      if (!profileFlow?.active || !profileFlow?.local || !profileFlow?.remote
        || !profileFlow?.lifecycleBoundary || !profileFlow?.connectDeepLink) {
        throw new Error('Packaged desktop local/remote/API profile flow failed');
      }
      mvpFlowProof = {
        connectDiscovery: true,
        localProfile: profileFlow.local,
        remoteActiveProfile: profileFlow.active && profileFlow.remote,
        lifecycleBoundary: profileFlow.lifecycleBoundary,
        connectUiPopulated: profileFlow.connectDeepLink,
      };
      await closePackagedProfileEditorAndWaitForWelcomeChooser(window);
    }
  } else if (packagedSmokeTest) {
    await assertPackagedMvpBoundary();
  }
  if (packagedSmokeTest && !connectJourney) {
    log('info', 'desktop.renderer.mvp_flows.ready', mvpFlowProof);
    log('info', PACKAGED_LAYOUT_READY_EVENT, { layout: await inspectPackagedLayout(window) });
    log('info', PACKAGED_REDUCED_NATIVE_WINDOW_READY_EVENT, {
      layout: inspectPackagedReducedNativeWindow(),
    });
  }
  log('info', 'desktop.renderer.ready', { preloadBridgeExposed: true });
  nativeRendererReady = true;
  maybeCompleteNativeFirstLaunch();
  return window;
};

const mainWindowRestorer = createMainWindowRestorer({
  getWindow: () => mainWindow,
  setWindow: window => { mainWindow = window; },
  createWindow: () => createMainWindow(null),
  shutdownStarted: () => shutdownStarted,
  creationFailed: error => log('error', 'desktop.window.restore_failed', { error }),
});

const restoreMainWindow = (): void => mainWindowRestorer.restore();

app.on('open-url', (event, url) => {
  event.preventDefault();
  if (shutdownStarted) return;
  const normalized = normalizeDeepLink(url);
  if (normalized) deliverDeepLink(normalized);
});

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    if (shutdownStarted) return;
    const deepLink = deepLinkFromArguments(argv);
    if (deepLink) deliverDeepLink(deepLink);
    else recordNativeRejectedArguments(argv);
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  registerProtocolClient();
  void app.whenReady().then(async () => {
    logger = createDesktopLogger(
      join(app.getPath('logs'), 'desktop.jsonl'),
      () => packagedSmokeEvidence?.write('desktop.log.write_failed'),
    );
    log('info', 'desktop.app.ready', { version: app.getVersion(), platform: process.platform });
    if (nativeSmokePhase) {
      const expectedVersion = process.env.PROPR_DESKTOP_NATIVE_EXPECTED_VERSION;
      const expectedPlatform = process.env.PROPR_DESKTOP_NATIVE_EXPECTED_PLATFORM;
      const expectedArch = process.env.PROPR_DESKTOP_NATIVE_EXPECTED_ARCH;
      if (!expectedVersion || app.getVersion() !== expectedVersion
        || expectedPlatform !== process.platform || expectedArch !== process.arch) {
        throw new Error('Native artifact application identity, version, or architecture mismatch');
      }
      recordNativeEvent('desktop.native.identity_verified');
    }
    const transportSmoke = packagedTransportSmoke();
    activePackagedTransportSmoke = transportSmoke;
    const connectSmoke = packagedConnectSmoke();
    activePackagedConnectJourney = Boolean(connectSmoke?.journeyEndpoint);
    packagedConnectJourneyDiagnosticState = connectSmoke?.journeyEndpoint && connectSmoke.journeyPhase
      ? { phase: connectSmoke.journeyPhase, stage: 'JOURNEY_NOT_STARTED' }
      : null;
    if (transportSmoke && connectSmoke) throw new Error('Packaged desktop smoke modes are mutually exclusive');
    const smokeProfileOrigin = packagedSmokeTest
      ? normalizeApiBaseUrl(process.env.PROPR_DESKTOP_SMOKE_PROFILE_API_URL ?? '')
      : null;
    let rendererPolicyOrigins: readonly string[] = packagedAcceptanceTest
      ? PACKAGED_ACCEPTANCE_LOOPBACK_ORIGINS
      : transportSmoke
      ? [transportSmoke.firstOrigin, transportSmoke.secondOrigin]
      : connectSmoke?.journeyEndpoint
        ? [connectSmoke.journeyEndpoint]
        : smokeProfileOrigin
          ? [smokeProfileOrigin]
          : [];
    const rendererPolicyPinnedForSmoke = transportSmoke !== null
      || connectSmoke?.journeyEndpoint !== undefined
      || (packagedSmokeTest && smokeProfileOrigin !== null);
    const reloadCurrentRendererForPolicyChange = createLatestRendererReloader(
      () => mainWindow?.webContents ?? null,
    );
    const contentSecurityPolicy = (): string => rendererContentSecurityPolicy(
      !app.isPackaged,
      rendererPolicyOrigins,
    );
    const disposeRendererProtocol = configurePackagedRendererProtocol(contentSecurityPolicy);
    const journeyStages = connectSmoke?.journeyPhase
      ? createPackagedJourneyStageTracker(connectSmoke.journeyPhase)
      : null;

    const productionEncryption: EncryptionProvider = {
      isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
      backend: () => {
        if (process.platform !== 'linux') return 'os-protected';
        try {
          return safeStorage.getSelectedStorageBackend();
        } catch {
          return 'unavailable';
        }
      },
      encrypt: value => safeStorage.encryptString(value),
      decrypt: value => safeStorage.decryptString(value),
    };
    const profiles = new ProfileStore(app.getPath('userData'), productionEncryption);
    if (nativeSmokePhase) {
      const security = profiles.security();
      const expectedBackend = process.platform === 'linux' ? 'gnome_libsecret' : 'os-protected';
      if (!security.available || security.backend !== expectedBackend) {
        recordNativeEvent('desktop.native.secure_storage_backend_invalid');
        throw new Error('Native artifact secure-storage backend is unavailable');
      }
    }
    const connectDiscovery = new DesktopConnectDiscoveryService(profiles, {
      supported: DESKTOP_CONNECT_DISCOVERY_PLATFORMS.has(process.platform),
      discover: async () => {
        const status = await discoverConfiguredConnect({
          configRoot: connectSmoke?.configRoot ?? join(app.getPath('home'), '.propr'),
          statusDependencies: connectSmoke ? {
            fetchImpl: connectSmoke.fetch,
            inspectTunnel: () => ({ kind: 'ok', running: true }),
          } : undefined,
          reportSmokeDiagnostic: connectSmoke
            ? diagnostic => log('info', 'desktop.renderer.connect_discovery.phase', {
                phase: diagnostic.phase,
                code: diagnostic.code,
                ...(diagnostic.substep ? { substep: diagnostic.substep } : {}),
                ...(diagnostic.category ? { category: diagnostic.category } : {}),
              })
            : undefined,
        });
        if (connectSmoke) {
          const statusCode = {
            incompatible: 'CONNECT_STATUS_INCOMPATIBLE',
            internalFailure: 'CONNECT_STATUS_INTERNAL_FAILURE',
            invalidConfig: 'CONNECT_STATUS_INVALID_CONFIG',
            notReady: 'CONNECT_STATUS_NOT_READY',
            ready: 'CONNECT_STATUS_READY',
            timeout: 'CONNECT_STATUS_TIMEOUT',
          }[status.status];
          log('info', 'desktop.renderer.connect_discovery.status', { code: statusCode });
        }
        return status;
      },
    });
    const packagedJourneyApprovals = connectSmoke?.journeyEndpoint
      ? createPackagedApprovalTaskTracker(openPackagedJourneyApproval)
      : null;
    const packagedJourneyAccountConfirmation = connectSmoke?.journeyEndpoint && connectSmoke.journeyPhase
      ? createPackagedConnectAccountConfirmation(connectSmoke.journeyEndpoint, connectSmoke.journeyPhase)
      : null;
    const credentials = new DesktopCredentialService({
      profiles,
      fetch: session.defaultSession.fetch.bind(session.defaultSession) as typeof globalThis.fetch,
      openPairingBrowser: packagedJourneyApprovals
        ? packagedJourneyApprovals.open
        : packagedAcceptanceTest
          ? async () => undefined
          : request => openApprovedDesktopPairingUrl(request, shell, {
              ambiguousOsLaunchFailure: supportsAmbiguousPairingLaunchRecovery(process.platform),
            }),
      copyPairingApproval: request => copyApprovedDesktopPairingUrl(request, clipboard),
      clientName: `ProPR Desktop (${process.platform})`,
      confirmAccount: async (account, origin, signal) => {
        if (!mainWindow || mainWindow.isDestroyed() || signal.aborted) return false;
        if (packagedJourneyAccountConfirmation) {
          return packagedJourneyAccountConfirmation.confirm(account, origin, signal);
        }
        if (acceptanceAccountConfirmation) {
          return acceptanceAccountConfirmation(account, origin, signal);
        }
        const result = await dialog.showMessageBox(mainWindow, {
          signal,
          type: 'question',
          title: 'Confirm GitHub account',
          message: `Save @${account.username} for this instance?`,
          detail: `${origin}\n\nThis is the identity approved by your browser. If it is the wrong account, cancel and open the approval link in a browser profile signed in to the intended GitHub account.`,
          buttons: ['Cancel', `Save @${account.username}`],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        });
        return result.response === 1;
      },
      reportRevocationFailure: diagnostic => {
        log('warn', 'desktop.credential_revocation.retry_pending', diagnostic);
      },
      reportCredentialDecision: decision => {
        log('info', 'desktop.credential_decision', { ...decision });
      },
      reportPairingProgress: progress => {
        log(progress.stage === 'browser-open-failed' ? 'warn' : 'info', 'desktop.authentication_pair.progress', {
          stage: progress.stage,
        });
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(IPC_CHANNELS.authenticationProgress, progress);
        }
      },
      ...(packagedAcceptanceTest ? {
        reportWebSocketHandshake: (evidence: DesktopWebSocketHandshakeEvidence) => {
          log('info', 'desktop.acceptance.websocket_handshake', { ...evidence });
        },
        reportCurrentUserValidation: (evidence: DesktopCurrentUserProxyEvidence) => {
          log('info', 'desktop.acceptance.current_user_proxy', { ...evidence });
        },
      } : {}),
      snapshotConnectIdentityClaim: (profileId, origin) =>
        connectDiscovery.snapshotIdentityClaim(profileId, origin),
      ...(acceptancePairingTiming ? { pairingTiming: acceptancePairingTiming } : {}),
    });
    const sessionSecurity = configureDesktopSessionSecurity({
      ipcMain,
      requestMicrophoneConsent: async (renderer, signal) => {
        const owner = BrowserWindow.fromWebContents(renderer);
        if (!owner || owner.isDestroyed() || signal.aborted) return false;
        return requestDesktopMicrophoneConsent({
          platform: process.platform,
          signal,
          confirm: async () => {
            const result = await dialog.showMessageBox(owner, {
              type: 'question',
              title: 'Allow microphone access check?',
              message: 'Allow ProPR to check microphone access?',
              detail: 'This check opens the microphone and immediately releases it. Audio is not recorded or sent. Voice commands are unavailable in this desktop runtime. No camera access is granted. Permission ends when the check finishes, is cancelled, or after 30 seconds.',
              buttons: ['Deny', 'Allow microphone'],
              defaultId: 0,
              cancelId: 0,
              noLink: true,
              signal,
            });
            return result.response === 1;
          },
          askForMacAccess: () => systemPreferences.askForMediaAccess('microphone'),
        });
      },
      contentSecurityPolicy,
      credentials,
      desktopSession: session.defaultSession,
      enableRendererNetworkBoundary: process.platform !== 'win32',
      getMainRenderer: () => mainWindow?.webContents ?? null,
      isTrustedRendererUrl: value => isTrustedRendererUrl(value, devServerUrl, packagedRendererUrl),
      ...(packagedAcceptanceTest ? {
        reportNetworkPermissionDecision: (evidence: DesktopNetworkPermissionEvidence) => {
          log('info', 'desktop.acceptance.network_permission', { ...evidence });
        },
        reportRendererOwnershipDecision: (evidence: DesktopRendererOwnershipEvidence) => {
          log('info', 'desktop.acceptance.renderer_ownership', { ...evidence });
        },
      } : connectSmoke?.journeyEndpoint ? {
        reportNetworkPermissionDecision: (evidence: DesktopNetworkPermissionEvidence) => {
          log('info', 'desktop.renderer.connect_network_permission', { ...evidence });
        },
        reportRendererOwnershipDecision: createPackagedConnectOwnershipReporter(evidence => {
          log('info', PACKAGED_CONNECT_RENDERER_OWNERSHIP_EVENT, { ...evidence });
        }),
      } : {}),
    });
    const credentialInitialization = await credentials.initialize();
    if (credentialInitialization.status === 'degraded') {
      log('warn', 'desktop.credential_revocation.startup_degraded', {
        retryPending: credentialInitialization.retryPending,
      });
    }
    if (nativeSmokePhase) {
      const current = await profiles.list();
      const expected = new Map([
        ['native-local', 'http://localhost:44221'],
        ['native-tunnel', 'https://t-preserved.propr.dev'],
      ]);
      if (nativeSmokePhase === 'first') {
        if (current.activeProfileId !== null || current.profiles.length !== 0) {
          throw new Error('Native first launch did not start with an isolated profile');
        }
        await profiles.save({
          id: 'native-local',
          label: 'Preserved local profile',
          apiBaseUrl: expected.get('native-local')!,
        });
        await profiles.save({
          id: 'native-tunnel',
          label: 'Native ProPR Connect tunnel',
          apiBaseUrl: expected.get('native-tunnel')!,
        });
        await profiles.setActive('native-local');
      } else if (current.activeProfileId !== 'native-local' || current.profiles.length !== expected.size
        || current.profiles.some(profile => expected.get(profile.id) !== profile.apiBaseUrl)) {
        throw new Error('Native relaunch did not preserve the non-secret profile state exactly');
      }
    }
    if (app.isPackaged && !rendererPolicyPinnedForSmoke) {
      if (!packagedAcceptanceTest) {
        const current = await credentials.listProfiles();
        const activeOrigin = current.profiles
          .find(profile => profile.id === current.activeProfileId)?.apiBaseUrl;
        rendererPolicyOrigins = activeOrigin?.startsWith('http://') ? [activeOrigin] : [];
      }
    }
    const lifecycle = new LocalLifecycleController();
    const notifications = new NativeNotificationService({
      statePath: join(app.getPath('userData'), 'desktop-notification-preferences.json'),
      platform: process.platform,
      isSupported: () => Notification.isSupported(),
      isActiveScope: scope => credentials.isActiveConnectionScope(scope),
      show: (payload, events) => {
        const notification = new Notification(createDesktopNotificationOptions({
          platform: process.platform,
          title: payload.title,
          body: payload.body,
          iconPath: desktopWindowIcon?.path,
        }));
        return showElectronNotification(notification, events);
      },
      navigate: path => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
        mainWindow.webContents.send(IPC_CHANNELS.notificationNavigate, path);
      },
      log: (level, event) => log(level, event),
      onSettingsChanged: scope => {
        const commands = desktopNativeCommands;
        commands?.refresh();
        if (scope && commands && mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(IPC_CHANNELS.notificationsChanged, scope);
        }
      },
    });
    desktopNativeCommands = createDesktopNativeCommandDispatcher({
      showAbout: () => {
        const detail = applicationAboutDetails(app.getVersion(), process.platform, process.arch, process.versions);
        void showApplicationAbout({
          showMessageBox: options => dialog.showMessageBox(options),
          copy: text => clipboard.writeText(text),
          openExternal: openAllowedExternalUrl,
        }, detail)
          .catch(() => log('warn', 'desktop.about.open_failed'));
      },
      openExternal: openAllowedExternalUrl,
      channel: IPC_CHANNELS.nativeCommand,
      getWindow: () => mainWindow,
      restoreWindow: restoreMainWindow,
      activeConnectionScope: () => credentials.activeConnectionScope(),
      activeNotificationScope: () => notifications.activeScope(),
      notificationState: () => {
        const settings = notifications.activeSettings();
        return {
          available: settings?.capability.supported === true,
          enabled: settings?.preferences.enabled === true,
        };
      },
      setNativeNotificationsEnabled: (scope, enabled) => notifications.setActiveEnabled(scope, enabled),
      quit: () => app.quit(),
      log: (level, event) => log(level, event),
    });
    const applicationMenu = configureApplicationMenu(Menu, desktopNativeCommands, process.platform);
    nativeProfiles = profiles;
    const trayArtworkPath = resolveDesktopTrayIconPath({
      isPackaged: app.isPackaged,
      mainBundleDirectory: __dirname,
      resourcesPath: process.resourcesPath,
    });
    const trayArtwork = nativeImage.createFromPath(trayArtworkPath);
    const trayIcon = trayArtwork.isEmpty()
      ? trayArtwork
      : trayArtwork.resize({ width: process.platform === 'darwin' ? 18 : 22 });
    if (process.platform === 'darwin' && !trayIcon.isEmpty()) trayIcon.setTemplateImage(true);
    const desktopTray = createDesktopTrayController({
      platform: process.platform,
      icon: trayIcon,
      createTray: icon => new Tray(icon),
      buildMenu: template => Menu.buildFromTemplate(template),
      setBadgeCount: count => {
        try { return app.setBadgeCount(count); } catch { return false; }
      },
      fetchActiveWork: signal => credentials.fetchActiveWork(signal),
      commands: desktopNativeCommands,
      log: (level, event, fields) => log(level, event, fields),
    });
    const setupHost = process.platform === 'linux'
      ? await createDesktopSetupHost({
          configDir: join(app.getPath('userData'), 'local-setup', 'cli'),
          authenticationHandoff: launchDesktopAuthentication,
          ...(app.isPackaged ? { resourcesPath: process.resourcesPath } : {}),
          ...(!app.isPackaged && process.env.PROPR_DESKTOP_RUNTIME_MANIFEST
            ? { runtimeManifestPath: process.env.PROPR_DESKTOP_RUNTIME_MANIFEST }
            : {}),
        })
      : { actions: {} as SetupActions, resolveApiBaseUrl: async () => { throw new Error('Local setup is unsupported'); } };
    const setup = new DesktopSetupController({
      actions: setupHost.actions,
      platform: process.platform,
      appDataDir: app.getPath('userData'),
      defaultRootDir: join(app.getPath('userData'), 'local-runtime'),
      statePath: join(app.getPath('userData'), 'local-setup', 'state.json'),
      selectPrivateKey: async () => {
        const result = await dialog.showOpenDialog({
          title: 'Choose GitHub App private key', properties: ['openFile'],
          filters: [{ name: 'Private keys', extensions: ['pem', 'key'] }],
        });
        return result.canceled ? null : result.filePaths[0] ?? null;
      },
      promptWebhookSecret: promptForWebhookSecret,
      resolveApiBaseUrl: setupHost.resolveApiBaseUrl,
      emit: snapshot => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC_CHANNELS.setupProgress, snapshot); },
      diagnose: (event, fields) => log('error', event, fields),
    });
    const registeredIpc = registerIpcHandlers({
      app,
      ipcMain,
      profiles,
      credentials,
      connectDiscovery,
      lifecycle,
      setup,
      notifications,
      logger,
      desktopSession: session.defaultSession,
      devServerUrl,
      packagedRendererUrl,
      openExternal: openAllowedExternalUrl,
      platform: process.platform,
      windowForSender: event => mainWindow?.webContents === event.sender ? mainWindow : null,
      rendererConsumerReady: event => {
        const ready = deepLinkDelivery.rendererConsumerReady(event.sender, event.senderFrame);
        if (ready) recordNativeEvent('desktop.deeplink.consumer_ready');
        return ready;
      },
      hasPendingConnectIntent: () => deepLinkDelivery.hasPendingConnectIntent(),
      acknowledgeDeepLink: (event, acknowledgement) =>
        deepLinkDelivery.acknowledgeSender(event.sender, acknowledgement),
      onActiveWorkConnectionAvailable: () => {
        desktopTray.connectionAvailable();
        desktopNativeCommands?.connectionAvailable();
      },
      onActiveWorkConnectionUnavailable: reason => {
        desktopTray.connectionUnavailable(reason);
        desktopNativeCommands?.connectionUnavailable();
      },
      onActiveWorkRefresh: () => desktopTray.refresh(),
      onNativeNavigationState: state => desktopNativeCommands?.updateNavigationState?.(state),
      ...(app.isPackaged && !rendererPolicyPinnedForSmoke ? {
        onRendererActiveProfileChanged: (origin: string | null) => {
          notifications.clear();
          if (packagedAcceptanceTest) return;
          const nextOrigins = origin?.startsWith('http://') ? [origin] : [];
          if (rendererPolicyOrigins.length === nextOrigins.length
            && rendererPolicyOrigins.every((value, index) => value === nextOrigins[index])) return;
          rendererPolicyOrigins = nextOrigins;
          // The next document receives the exact policy in both its meta tag and
          // response header. Until then, the existing CSP and request boundary
          // both fail closed for the new active endpoint.
          reloadCurrentRendererForPolicyChange();
        },
      } : {}),
      ...(journeyStages ? {
        reportAcceptanceJourneyStage: (stage: DesktopAcceptanceJourneyStage) => {
          journeyStages.record(stage);
        },
        reportAcceptanceOperation: (
          operation: DesktopAcceptanceOperation,
          status: DesktopAcceptanceOperationStatus,
        ) => {
          log('info', PACKAGED_CONNECT_JOURNEY_OPERATION_EVENT, { operation, status });
        },
      } : {}),
    });
    const shutdownLifecycle = transportSmoke?.shutdownMode === 'forced-timeout'
      ? { shutdown: () => new Promise<void>(() => undefined) }
      : lifecycle;
    const shutdown = createDesktopShutdownCoordinator({
      credentials,
      lifecycle: shutdownLifecycle,
      deepLinks: deepLinkDelivery,
      tray: desktopTray,
      nativeActions: {
        close: () => {
          applicationMenu.close();
          desktopNativeCommands?.close();
          desktopNativeCommands = null;
        },
      },
      setup,
      ipc: registeredIpc,
      profiles,
      notifications,
      sessionSecurity,
      disposeRendererProtocol,
      getWindow: () => mainWindow,
      quit: () => app.quit(),
      onStarted: () => { shutdownStarted = true; },
      log,
    }, transportSmoke?.shutdownMode === 'forced-timeout' ? { drainTimeoutMs: 250 } : undefined);
    app.on('before-quit', event => shutdown.beforeQuit(event));

    mainWindow = await createMainWindow();
    desktopTray.start();

    if (connectSmoke) {
      reportPackagedConnectJourneyStage('JOURNEY_DISCOVERY_RENDERER');
      const readyFields = await runPackagedConnectDiscoverySmoke(mainWindow);
      if (connectSmoke.journeyEndpoint && connectSmoke.journeyPhase) {
        if (!journeyStages || !packagedJourneyApprovals) {
          throw new Error('Packaged Connect journey stage tracker was unavailable');
        }
        await runPackagedConnectJourneySmoke(
          mainWindow,
          profiles,
          credentials,
          packagedJourneyApprovals.waitForNextOpen,
          packagedJourneyApprovals.waitForIdle,
          connectSmoke.journeyEndpoint,
          connectSmoke.journeyPhase,
          journeyStages,
        );
      }
      packagedJourneyAccountConfirmation?.assertComplete();
      await publishPackagedConnectReady(readyFields);
      packagedConnectJourneyDiagnosticState = null;
      app.quit();
    } else if (transportSmoke) {
      await runPackagedTransportSmoke(mainWindow, profiles, credentials, transportSmoke);
      app.quit();
      if (transportSmoke.shutdownMode === 'retry') {
        log('info', 'desktop.app.shutdown_retry_requested');
        app.quit();
      }
    } else if (packagedSmokeTest && nativeSmokePhase !== 'first') {
      app.quit();
    } else {
      mainWindow.show();
    }

    const updateConfig = __PROPR_DESKTOP_UPDATE_MANIFEST_URL__
      ? {
          manifestUrl: __PROPR_DESKTOP_UPDATE_MANIFEST_URL__,
          publicKey: __PROPR_DESKTOP_UPDATE_PUBLIC_KEY__,
          signingIdentity: __PROPR_DESKTOP_UPDATE_SIGNING_IDENTITY__,
          windowsSignerPins: __PROPR_DESKTOP_WINDOWS_SIGNER_PINS__,
        }
      : undefined;
    if (app.isPackaged && process.platform !== 'win32' && updateConfig && !packagedSmokeTest && !packagedAcceptanceTest) {
      const runUpdateCheck = () => {
        void checkForSignedUpdates({
          config: updateConfig,
          currentVersion: app.getVersion(),
          platform: process.platform,
          arch: process.arch,
          request: (url, init) => net.fetch(url, init),
          cacheDirectory: join(app.getPath('userData'), 'verified-updates'),
        }).then(result => log('info', 'desktop.update.check_complete', { result }))
          .catch(() => log('error', 'desktop.update.check_failed'));
      };
      runUpdateCheck();
    }

    app.on('activate', () => {
      if (shutdownStarted) return;
      if (BrowserWindow.getAllWindows().length === 0) {
        void createMainWindow(null).then(window => {
          mainWindow = window;
        });
      }
    });
  }).catch(error => {
    if (packagedConnectJourneyDiagnosticState) {
      log('error', PACKAGED_CONNECT_JOURNEY_FAILURE_EVENT, {
        phase: packagedConnectJourneyDiagnosticState.phase,
        stage: packagedConnectJourneyDiagnosticState.stage,
        reason: packagedConnectJourneyFailureReason(error),
      });
    }
    log('error', 'desktop.app.start_failed', { error });
    app.exit(1);
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  packagedSmokeEvidence?.close();
  packagedSmokeEvidence = null;
});
