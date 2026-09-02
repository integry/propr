import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PACKAGED_ACCEPTANCE_RENDERER_LIFECYCLE_PREFIX,
  reportPackagedAcceptanceRendererLifecycle,
  reportPackagedAcceptanceSocketConstructionInvocation,
} from './packagedAcceptanceRendererLifecycle';

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
      'connectInvocations', 'connectionScope', 'desktopRuntime', 'phase', 'profileActivationPublished',
      'providerDisabled', 'schemaVersion', 'socketConstructionInvocations', 'socketConstructions',
      'socketProviderMounted',
    ]);
    expect(evidence).toMatchObject({
      schemaVersion: 1,
      phase: 'socket-construction-invoked',
      profileActivationPublished: true,
      connectionScope: 'available',
      socketConstructionInvocations: 2,
    });
    expect(JSON.stringify(evidence)).not.toMatch(/scope-|https?:|profile-|bearer|authorization|cookie|path|error/i);
  });
});
