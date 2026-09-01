import { randomUUID } from 'node:crypto';
import { createSetupState, updateStep } from '@propr/local-setup';
import type { DesktopSetupRequest, DesktopSetupSnapshot } from './shared/contract';

type AcceptanceSetupScenario = 'default' | 'setup-error' | 'setup-complete';

const capability = { supported: true, kind: 'local', platform: 'linux' } as const;

export class AcceptanceSetupController {
  readonly #sessionId = randomUUID();
  readonly #rootDir: string;
  readonly #emit: (snapshot: DesktopSetupSnapshot) => void;
  readonly #scenario: AcceptanceSetupScenario;
  #timers = new Set<ReturnType<typeof setTimeout>>();
  #snapshot: DesktopSetupSnapshot;

  constructor(options: {
    rootDir: string;
    scenario?: string;
    emit(snapshot: DesktopSetupSnapshot): void;
  }) {
    this.#rootDir = options.rootDir;
    this.#emit = options.emit;
    this.#scenario = options.scenario === 'setup-error' || options.scenario === 'setup-complete'
      ? options.scenario
      : 'default';
    this.#snapshot = this.#initialSnapshot();
  }

  #initialSnapshot(): DesktopSetupSnapshot {
    const common = { capability, sessionId: this.#sessionId, rootDir: this.#rootDir, logs: [] };
    if (this.#scenario === 'setup-error') {
      return {
        ...common,
        phase: 'failed',
        state: updateStep(createSetupState(this.#rootDir), 'check', {
          status: 'failed',
          detail: 'Docker Engine is not reachable.',
          nextAction: 'Start Docker Engine, then retry setup.',
        }),
        error: 'The local prerequisites need attention.',
        errors: [{
          code: 'step-failed',
          message: 'Docker Engine is not reachable.',
          stepId: 'check',
          retryable: true,
          nextAction: 'Start Docker Engine, then retry setup.',
        }],
        resumeAvailable: true,
      };
    }
    if (this.#scenario === 'setup-complete') {
      return {
        ...common,
        phase: 'completed',
        profile: {
          id: 'acceptance-local',
          name: 'This computer',
          baseUrl: 'http://127.0.0.1:41771',
          kind: 'local',
          lastConnectedAt: '2026-01-02T03:04:05.000Z',
        },
      };
    }
    return { ...common, phase: 'idle', resumeAvailable: false };
  }

  async status(): Promise<DesktopSetupSnapshot> { return structuredClone(this.#snapshot); }

  async start(request: DesktopSetupRequest): Promise<DesktopSetupSnapshot> {
    if (request.sessionId !== this.#sessionId) throw new Error('Acceptance setup session expired');
    let state = createSetupState(this.#rootDir);
    state = updateStep(state, 'check', { status: 'done', detail: 'Docker Engine 27.5 is ready.' });
    state = updateStep(state, 'init-stack', { status: 'done', detail: 'Private local directory is ready.' });
    state = updateStep(state, 'pull-images', { status: 'active', detail: 'Preparing deterministic service images…' });
    this.#snapshot = {
      phase: 'running', capability, sessionId: this.#sessionId, rootDir: this.#rootDir,
      state, logs: ['Environment checks passed.', 'Preparing local services…'], resumeAvailable: false,
    };
    this.#publish();
    // Keep the progress view stable for the complete screenshot/a11y variant
    // set. Completion has its own deterministic cold-start scenario.
    this.#later(60_000, () => {
      let completed = createSetupState(this.#rootDir);
      completed = { ...completed, steps: completed.steps.map(step => ({ ...step, status: step.optional ? 'skipped' : 'done', detail: step.optional ? 'Not requested' : 'Ready' })) };
      this.#snapshot = {
        phase: 'completed', capability, sessionId: this.#sessionId, rootDir: this.#rootDir,
        state: completed, logs: ['Environment checks passed.', 'Local services are healthy.'],
        profile: {
          id: 'acceptance-local', name: 'This computer', baseUrl: 'http://127.0.0.1:41771', kind: 'local',
          lastConnectedAt: '2026-01-02T03:04:05.000Z',
        },
      };
      this.#publish();
    });
    return structuredClone(this.#snapshot);
  }

  retry(request?: DesktopSetupRequest): Promise<DesktopSetupSnapshot> {
    if (request) return this.start(request);
    this.#snapshot = { ...this.#snapshot, phase: 'idle', error: undefined, errors: undefined };
    this.#publish();
    return this.status();
  }

  async cancel(): Promise<DesktopSetupSnapshot> {
    this.#clearTimers();
    this.#snapshot = { ...this.#snapshot, phase: 'cancelled', error: 'Setup was cancelled.' };
    this.#publish();
    return this.status();
  }

  async selectPrivateKey() { return { capability: 'A'.repeat(43), label: 'acceptance-private-key.pem' }; }
  async acquireWebhookSecret() { return { capability: 'B'.repeat(43), label: 'Secret entered' as const }; }
  async shutdown(): Promise<void> { this.#clearTimers(); }

  #publish(): void { this.#emit(structuredClone(this.#snapshot)); }
  #later(delay: number, callback: () => void): void {
    const timer = setTimeout(() => { this.#timers.delete(timer); callback(); }, delay);
    this.#timers.add(timer);
  }
  #clearTimers(): void { for (const timer of this.#timers) clearTimeout(timer); this.#timers.clear(); }
}
