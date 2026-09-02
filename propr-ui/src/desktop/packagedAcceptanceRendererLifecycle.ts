export const PACKAGED_ACCEPTANCE_RENDERER_LIFECYCLE_PREFIX = '[ProPR Acceptance Renderer Lifecycle]';

export type PackagedAcceptanceRendererLifecyclePhase =
  | 'profile-activation-published'
  | 'socket-provider-mounted'
  | 'socket-effect-disabled'
  | 'socket-effect-scope-unavailable'
  | 'socket-effect-ready'
  | 'socket-construction-invoked'
  | 'socket-constructed'
  | 'socket-connect-invoked';

export interface PackagedAcceptanceRendererLifecycleEvidence {
  schemaVersion: 2;
  phase: PackagedAcceptanceRendererLifecyclePhase;
  profileActivationPublished: boolean;
  socketProviderMounted: boolean;
  providerDisabled: boolean;
  disabledByDemoModeLoading: boolean;
  disabledByDemoMode: boolean;
  disabledByCurrentUserLoading: boolean;
  disabledByCurrentUserAbsent: boolean;
  desktopRuntime: boolean;
  connectionScope: 'unknown' | 'available' | 'unavailable';
  socketConstructionInvocations: number;
  socketConstructions: number;
  connectInvocations: number;
}

type AcceptanceWindow = Window & {
  __PROPR_PACKAGED_ACCEPTANCE__?: unknown;
};

const initialEvidence: PackagedAcceptanceRendererLifecycleEvidence = {
  schemaVersion: 2,
  phase: 'profile-activation-published',
  profileActivationPublished: false,
  socketProviderMounted: false,
  providerDisabled: false,
  disabledByDemoModeLoading: false,
  disabledByDemoMode: false,
  disabledByCurrentUserLoading: false,
  disabledByCurrentUserAbsent: false,
  desktopRuntime: false,
  connectionScope: 'unknown',
  socketConstructionInvocations: 0,
  socketConstructions: 0,
  connectInvocations: 0,
};

let evidence = initialEvidence;
let reportCount = 0;
const REPORT_LIMIT = 12;

const acceptanceEvidenceEnabled = (): boolean => typeof window !== 'undefined'
  && typeof (window as AcceptanceWindow).__PROPR_PACKAGED_ACCEPTANCE__ === 'object'
  && (window as AcceptanceWindow).__PROPR_PACKAGED_ACCEPTANCE__ !== null;

const boundedCount = (value: number): number => Math.min(2, value + 1);

export const reportPackagedAcceptanceRendererLifecycle = (
  phase: PackagedAcceptanceRendererLifecyclePhase,
  update: Partial<Omit<PackagedAcceptanceRendererLifecycleEvidence, 'schemaVersion' | 'phase'>> = {},
): void => {
  if (!acceptanceEvidenceEnabled() || reportCount >= REPORT_LIMIT) return;
  reportCount += 1;
  evidence = { ...evidence, ...update, schemaVersion: 2, phase };
  console.info(PACKAGED_ACCEPTANCE_RENDERER_LIFECYCLE_PREFIX, evidence);
};

export const reportPackagedAcceptanceSocketConstructionInvocation = (): void => {
  reportPackagedAcceptanceRendererLifecycle('socket-construction-invoked', {
    socketConstructionInvocations: boundedCount(evidence.socketConstructionInvocations),
  });
};

export const reportPackagedAcceptanceSocketConstructed = (): void => {
  reportPackagedAcceptanceRendererLifecycle('socket-constructed', {
    socketConstructions: boundedCount(evidence.socketConstructions),
  });
};

export const reportPackagedAcceptanceSocketConnectInvocation = (): void => {
  reportPackagedAcceptanceRendererLifecycle('socket-connect-invoked', {
    connectInvocations: boundedCount(evidence.connectInvocations),
  });
};
