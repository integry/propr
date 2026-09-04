import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PACKAGED_ACCEPTANCE_RENDERER_LIFECYCLE_PREFIX,
  reportPackagedAcceptanceRendererLifecycle,
  reportPackagedAcceptanceSocketConstructionInvocation,
} from './packagedAcceptanceRendererLifecycle';
import {
  PACKAGED_ACCEPTANCE_CURRENT_USER_PREFIX,
  reportPackagedAcceptanceCurrentUser,
} from './packagedAcceptanceCurrentUserValidation';

type AcceptanceWindow = Window & { __PROPR_PACKAGED_ACCEPTANCE__?: unknown };

describe('packaged acceptance renderer lifecycle evidence', () => {
  afterEach(() => {
    delete (window as AcceptanceWindow).__PROPR_PACKAGED_ACCEPTANCE__;
    vi.restoreAllMocks();
  });

  it('is silent outside the authenticated packaged acceptance boundary', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    reportPackagedAcceptanceRendererLifecycle('socket-provider-mounted', {
      socketProviderMounted: true,
    });

    expect(info).not.toHaveBeenCalled();
  });

  it('emits only fixed bounded secret-free state', () => {
    (window as AcceptanceWindow).__PROPR_PACKAGED_ACCEPTANCE__ = { setZoomFactor: vi.fn() };
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    reportPackagedAcceptanceRendererLifecycle('profile-activation-published', {
      profileActivationPublished: true,
      connectionScope: 'available',
    });
    for (let index = 0; index < 20; index += 1) {
      reportPackagedAcceptanceSocketConstructionInvocation();
    }

    const [prefix, evidence] = info.mock.calls.at(-1)!;
    expect(info).toHaveBeenCalledTimes(12);
    expect(prefix).toBe(PACKAGED_ACCEPTANCE_RENDERER_LIFECYCLE_PREFIX);
    expect(Object.keys(evidence).sort()).toEqual([
      'connectInvocations', 'connectionScope', 'desktopRuntime', 'disabledByCurrentUserAbsent',
      'disabledByCurrentUserLoading', 'disabledByDemoMode', 'disabledByDemoModeLoading', 'phase',
      'profileActivationPublished', 'providerDisabled', 'schemaVersion', 'socketConstructionInvocations',
      'socketConstructions', 'socketProviderMounted',
    ]);
    expect(evidence).toMatchObject({
      schemaVersion: 2,
      phase: 'socket-construction-invoked',
      profileActivationPublished: true,
      connectionScope: 'available',
      socketConstructionInvocations: 2,
      disabledByDemoModeLoading: false,
      disabledByDemoMode: false,
      disabledByCurrentUserLoading: false,
      disabledByCurrentUserAbsent: false,
    });
    expect(JSON.stringify(evidence)).not.toMatch(/scope-|https?:|profile-|bearer|authorization|cookie|path|error/i);
  });

  it('emits bounded current-user stages without identity or transport values', () => {
    (window as AcceptanceWindow).__PROPR_PACKAGED_ACCEPTANCE__ = { setZoomFactor: vi.fn() };
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    for (let index = 0; index < 20; index += 1) {
      reportPackagedAcceptanceCurrentUser({
        phase: 'request-issued',
        scopeGeneration: 1,
        activeScopePresent: true,
        responseStatus: 0,
        classification: 'pending',
        schemaAccepted: false,
      });
    }

    expect(info).toHaveBeenCalledTimes(10);
    const [prefix, evidence] = info.mock.calls.at(-1)!;
    expect(prefix).toBe(PACKAGED_ACCEPTANCE_CURRENT_USER_PREFIX);
    expect(evidence).toEqual({
      schemaVersion: 1,
      correlation: 'current-scope-user-validation',
      phase: 'request-issued',
      scopeGeneration: 1,
      activeScopePresent: true,
      responseStatus: 0,
      classification: 'pending',
      schemaAccepted: false,
    });
    expect(JSON.stringify(evidence)).not.toMatch(/https?:|profile-|bearer|authorization|cookie|user data|path/i);
  });
});

