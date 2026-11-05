import type { DesktopBridge, DesktopSetupSnapshot } from './shared/contract';

/** Data-only fixture at the preload boundary. Never imports the provisioning service. */
export const createPackagedAcceptanceSetup = (authorized: boolean, scenario: string | undefined) => {
  if (!authorized) return null;
  const base: DesktopSetupSnapshot = {
    phase: 'idle', capability: { supported: true, kind: 'local', platform: 'linux' },
    sessionId: '11111111-1111-4111-8111-111111111111', logs: [],
  };
  const running: DesktopSetupSnapshot = {
    ...base, phase: 'running',
    state: { rootDir: '/acceptance/local-runtime', steps: [
      { id: 'check', title: 'Environment checks', description: 'Docker Engine is available.', optional: false, status: 'done' },
      { id: 'init-stack', title: 'Initialize stack', description: 'Private local storage is ready.', optional: false, status: 'done' },
      { id: 'pull-images', title: 'Pull images', description: 'Preparing local service images.', optional: false, status: 'active' },
      { id: 'start-stack', title: 'Start stack', description: 'Start the private local services.', optional: false, status: 'pending' },
    ] }, logs: ['Environment checks passed.', 'Preparing local service images…'],
  };
  const failed: DesktopSetupSnapshot = {
    ...base, phase: 'failed', resumeAvailable: true,
    resume: { github: { mode: 'relay' }, intake: { mode: 'routing_websocket' }, agents: ['codex'], reinitialize: false, whitelist: null, repository: null },
    state: { rootDir: '/acceptance/local-runtime', steps: [{
      id: 'start-stack', title: 'Start stack', description: 'Check local services.', optional: false, status: 'failed',
      detail: 'The running local stack uses a different runtime version.',
      nextAction: 'Retry after stopping the old stack, or restart with the aligned runtime. You can also review your saved choices.',
      recoveryAction: 'replace-running-stack',
    }] },
  };
  const completed: DesktopSetupSnapshot = {
    ...base, phase: 'completed', profile: {
      id: '22222222-2222-4222-8222-222222222222', name: 'Local acceptance workspace',
      // Owned loopback fixture: normal discovery/pairing checks, no external approval.
      baseUrl: 'http://127.0.0.2:41731', kind: 'local',
    },
  };
  let snapshot = scenario === 'setup-error' ? failed : scenario === 'setup-complete' ? completed : base;
  const calls: string[] = [];
  const copy = () => structuredClone(snapshot);
  const respond = (call: string, next: DesktopSetupSnapshot) => {
    calls.push(call); snapshot = next; return Promise.resolve(copy());
  };
  const unavailable = async (): Promise<never> => { throw new Error('Credentials and GitHub operations are unavailable in presentation fixtures'); };
  const localSetup: DesktopBridge['localSetup'] = {
    status: async () => copy(),
    start: () => respond('start', running),
    retry: request => respond(request && 'recoveryAction' in request ? 'replace-running-stack' : 'retry', running),
    cancel: () => respond('cancel', { ...failed, phase: 'cancelled', state: undefined, error: 'Setup was cancelled safely.' }),
    selectPrivateKey: unavailable, acquireWebhookSecret: unavailable, resolveGithubInstallation: unavailable,
    onProgress: () => () => undefined,
  };
  return { localSetup, evidence: () => ({ presentation: 'LocalSetupWizard', fixture: 'preload-setup-v1', phase: snapshot.phase, calls: [...calls] }) };
};
