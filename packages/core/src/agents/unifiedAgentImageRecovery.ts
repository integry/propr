import logger from '../utils/logger.js';

export const UNIFIED_AGENT_IMAGE_RETRY_BASE_DELAY_MS = 5_000;
export const UNIFIED_AGENT_IMAGE_RETRY_MAX_DELAY_MS = 5 * 60_000;
export const UNIFIED_AGENT_IMAGE_RETRY_MAX_ATTEMPTS = 5;
const UNIFIED_AGENT_IMAGE_RETRY_JITTER_RATIO = 0.25;
export const UNIFIED_AGENT_IMAGE_CIRCUIT_INSPECTION_INTERVAL_MS = 60_000;
export const UNIFIED_AGENT_IMAGE_CIRCUIT_COOLDOWN_MS = UNIFIED_AGENT_IMAGE_RETRY_MAX_DELAY_MS;

export interface CircuitOpenInspectionState {
    after: number;
    pending: Promise<void> | null;
}

/** The caller just observed the image missing locally; hold the next circuit-open inspection for a full interval. */
export function deferCircuitOpenInspection(state: CircuitOpenInspectionState): void {
    state.after = Date.now() + UNIFIED_AGENT_IMAGE_CIRCUIT_INSPECTION_INTERVAL_MS;
}

/**
 * An open circuit only stops preparation requests and retry timers; it must
 * not leave a consumer process permanently degraded after the worker has
 * prepared the image. Re-inspect local Docker state on a bounded interval so
 * a successful inspect-only refresh can clear the failure; this performs no
 * Docker build and no queue work.
 */
export function inspectUnifiedAgentImageWhileCircuitOpen(
    state: CircuitOpenInspectionState,
    pendingBackgroundRefresh: Promise<void> | null,
    refresh: () => Promise<void>,
): Promise<void> {
    if (pendingBackgroundRefresh) return pendingBackgroundRefresh;
    if (state.pending) return state.pending;
    if (Date.now() < state.after) return Promise.resolve();
    deferCircuitOpenInspection(state);
    state.pending = refresh()
        .catch(error => {
            logger.error({ error: (error as Error).message }, 'Inspect-only agent image check failed while the recovery circuit is open');
        })
        .finally(() => { state.pending = null; });
    return state.pending;
}

export interface UnavailableUnifiedAgentImage {
    imageTag?: string;
    error: string;
    recordedAt: string;
    retryCount?: number;
    nextRetryAt?: string;
    circuitBreakerOpen?: boolean;
    circuitOpenedAt?: string;
    operatorActionRequired?: boolean;
}

/** Time left before a transient open circuit may attempt preparation again. */
export function remainingUnifiedAgentImageCircuitCooldown(
    unavailable: UnavailableUnifiedAgentImage,
    now = Date.now(),
): number {
    const openedAt = unavailable.circuitOpenedAt ? Date.parse(unavailable.circuitOpenedAt) : Number.NaN;
    if (!Number.isFinite(openedAt)) return 0;
    return Math.max(0, openedAt + UNIFIED_AGENT_IMAGE_CIRCUIT_COOLDOWN_MS - now);
}

/**
 * Half-opens a bounded circuit and reports whether recovery must remain
 * inspect-only because the circuit is still open.
 */
export function mustStayInspectOnly(unavailable: UnavailableUnifiedAgentImage | null): boolean {
    halfOpenUnifiedAgentImageCircuit(unavailable);
    return !!unavailable?.circuitBreakerOpen;
}

/**
 * Bounded half-open transition. Disk pressure needs an operator and stays open,
 * but a circuit opened by transient failures must not disable preparation for
 * the lifetime of the process: after the cooldown the next attempt is allowed
 * through with a fresh retry budget. Returns true when the circuit was closed.
 */
export function halfOpenUnifiedAgentImageCircuit(
    unavailable: UnavailableUnifiedAgentImage | null | undefined,
    now = Date.now(),
): boolean {
    if (!unavailable?.circuitBreakerOpen || unavailable.operatorActionRequired) return false;
    if (remainingUnifiedAgentImageCircuitCooldown(unavailable, now) > 0) return false;
    unavailable.circuitBreakerOpen = undefined;
    unavailable.circuitOpenedAt = undefined;
    unavailable.retryCount = 0;
    unavailable.nextRetryAt = undefined;
    logger.warn({ imageTag: unavailable.imageTag, error: unavailable.error },
        'Unified agent image recovery circuit half-opened after its cooldown; resuming preparation attempts');
    return true;
}

export function getUnifiedAgentImageRetryDelay(
    retryCount: number,
    random = Math.random,
): number {
    const exponentialDelay = Math.min(
        UNIFIED_AGENT_IMAGE_RETRY_MAX_DELAY_MS,
        UNIFIED_AGENT_IMAGE_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, retryCount - 1),
    );
    const jitter = 1 + (random() * 2 - 1) * UNIFIED_AGENT_IMAGE_RETRY_JITTER_RATIO;
    return Math.round(exponentialDelay * jitter);
}

interface UnifiedAgentImageRetryOptions {
    unavailable: UnavailableUnifiedAgentImage | null;
    retryTimer: NodeJS.Timeout | null;
    startRecovery: (fromTimer: boolean) => Promise<void>;
    setRetryTimer: (timer: NodeJS.Timeout | null) => void;
}

function armUnifiedAgentImageRetryTimer(
    options: UnifiedAgentImageRetryOptions,
    unavailable: UnavailableUnifiedAgentImage,
    delay: number,
): void {
    const timer = setTimeout(() => {
        options.setRetryTimer(null);
        if (unavailable.circuitBreakerOpen && !halfOpenUnifiedAgentImageCircuit(unavailable)) return;
        void options.startRecovery(true);
    }, delay);
    timer.unref?.();
    options.setRetryTimer(timer);
}

export function scheduleUnifiedAgentImageRetry(options: UnifiedAgentImageRetryOptions): void {
    const { unavailable } = options;
    if (options.retryTimer || !unavailable) return;

    if (unavailable.circuitBreakerOpen) {
        // Only an operator can clear disk pressure. Every other open circuit is
        // released by its own timer so transient failures stay recoverable.
        if (unavailable.operatorActionRequired) return;
        armUnifiedAgentImageRetryTimer(options, unavailable, remainingUnifiedAgentImageCircuitCooldown(unavailable));
        return;
    }
    if ((unavailable.retryCount ?? 0) >= UNIFIED_AGENT_IMAGE_RETRY_MAX_ATTEMPTS) return;

    const delay = unavailable.nextRetryAt
        ? Math.max(0, Date.parse(unavailable.nextRetryAt) - Date.now())
        : getUnifiedAgentImageRetryDelay(unavailable.retryCount ?? 1);
    unavailable.nextRetryAt = new Date(Date.now() + delay).toISOString();
    armUnifiedAgentImageRetryTimer(options, unavailable, delay);
}

/**
 * Inspect-only observations while the circuit is open must not extend the
 * cooldown, so an already-open circuit keeps its original opening time.
 */
function circuitOpenedAt(open: boolean, previous: UnavailableUnifiedAgentImage | null): string | undefined {
    if (!open) return undefined;
    return previous?.circuitOpenedAt ?? new Date().toISOString();
}

export function recordUnifiedAgentImageFailure(options: {
    previous: UnavailableUnifiedAgentImage | null;
    imageTag: string | undefined;
    error: string;
    diskPressure: boolean;
    attemptFailed?: boolean;
}): { state: UnavailableUnifiedAgentImage; shouldRetry: boolean } {
    const sameImage = options.previous?.imageTag === options.imageTag;
    const previous = sameImage ? options.previous : null;
    const attemptFailed = options.attemptFailed ?? true;
    const retryCount = (previous?.retryCount ?? 0) + (attemptFailed ? 1 : 0);
    const circuitBreakerOpen = previous?.circuitBreakerOpen
        || options.diskPressure || retryCount >= UNIFIED_AGENT_IMAGE_RETRY_MAX_ATTEMPTS;
    const operatorActionRequired = previous?.operatorActionRequired || options.diskPressure;
    const nextRetryAt = attemptFailed
        ? new Date(Date.now() + getUnifiedAgentImageRetryDelay(retryCount)).toISOString()
        : previous?.nextRetryAt;
    const state: UnavailableUnifiedAgentImage = {
        imageTag: options.imageTag,
        error: options.error,
        recordedAt: new Date().toISOString(),
        retryCount,
        circuitBreakerOpen: circuitBreakerOpen || undefined,
        circuitOpenedAt: circuitOpenedAt(circuitBreakerOpen, previous),
        operatorActionRequired: operatorActionRequired || undefined,
        nextRetryAt: circuitBreakerOpen ? undefined : nextRetryAt,
    };
    if (circuitBreakerOpen) {
        logUnifiedAgentImageCircuitOpen(options.imageTag, options.error, retryCount, !!operatorActionRequired);
    }
    return { state, shouldRetry: !circuitBreakerOpen };
}

export function logUnifiedAgentImageCircuitOpen(
    imageTag: string | undefined,
    error: string,
    retryCount: number | undefined,
    diskPressure: boolean,
): void {
    logger.error(
        { imageTag, error, retryCount, diskPressure },
        diskPressure
            ? 'Unified agent image recovery halted by disk pressure; operator action is required'
            : 'Unified agent image recovery circuit breaker opened after repeated failures',
    );
}

export function startUnifiedAgentImageRecovery(options: {
    fromTimer?: boolean;
    scheduleRetry: () => void;
    unavailable: UnavailableUnifiedAgentImage | null;
    pendingBackgroundRefresh: Promise<void> | null;
    imageTag: string | undefined;
    isCurrent: () => boolean;
    clearRetry: () => void;
    enqueuePreparation: (imageTag: string) => Promise<unknown>;
    refresh: () => Promise<void>;
    recordFailure: (imageTag: string, error: string) => void;
    setPendingBackgroundRefresh: (promise: Promise<void> | null) => void;
}): Promise<void> {
    if (options.pendingBackgroundRefresh) {
        // The timer has been consumed. Re-evaluate the current failure state
        // after the refresh settles so an overlapping refresh cannot drop it.
        return options.fromTimer
            ? options.pendingBackgroundRefresh.then(options.scheduleRetry, options.scheduleRetry)
            : options.pendingBackgroundRefresh;
    }
    if (!options.imageTag) return Promise.resolve();
    const unavailable = options.unavailable?.imageTag === options.imageTag ? options.unavailable : null;
    // Inspect-only discovery has not attempted preparation yet. Let the first
    // attempt proceed, then enforce its deadline for both owners and consumers.
    // A fired timer already waited; its clock can lead Date.now() slightly.
    if (unavailable?.circuitBreakerOpen || (
        !options.fromTimer
        && (unavailable?.retryCount ?? 0) > 0
        && unavailable?.nextRetryAt
        && Date.parse(unavailable.nextRetryAt) > Date.now()
    )) return Promise.resolve();

    options.clearRetry();
    const recovery = options.enqueuePreparation(options.imageTag)
        .then(() => options.isCurrent() ? options.refresh() : undefined)
        .catch(error => {
            if (!options.isCurrent()) return;
            const message = error instanceof Error ? error.message : String(error);
            options.recordFailure(options.imageTag as string, message);
            logger.error({ imageTag: options.imageTag, error: message }, 'Worker-owned unified agent image recovery failed');
        })
        .finally(() => options.setPendingBackgroundRefresh(null));
    options.setPendingBackgroundRefresh(recovery);
    return recovery;
}
