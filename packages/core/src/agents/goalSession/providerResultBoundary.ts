import type {
    GoalModelChangeAcknowledgement,
    GoalPauseAcknowledgement,
    GoalProviderReconcileResult,
    GoalProviderSessionSnapshot,
    GoalSessionEvent,
    GoalSessionJsonValue,
} from './contract.js';
import { isSafeIdentifier } from './safeIdentifier.js';
import { GoalSessionContractError, StaleGoalSessionFenceError } from './errors.js';
import { sanitizeNewRecoveryMetadata } from './recoveryMetadata.js';
import { safeProviderException, sanitizeGoalSessionEvent } from './securityBoundary.js';

type ClosedRecord = Record<string, unknown>;

export async function untrustedProviderResult<T, R>(
    effect: () => T | Promise<T>,
    rebuild: (value: Awaited<T>) => R,
): Promise<R> {
    try {
        return rebuild(await effect());
    } catch (error) {
        if (error instanceof StaleGoalSessionFenceError) throw error;
        throw safeProviderException(error);
    }
}

/**
 * Provider values are capabilities, not data.  This module evaluates every
 * proxy trap/accessor and reconstructs a fresh, closed DTO while the call is
 * still inside GoalSessionCore's untrusted-provider try/catch.
 */
export function rebuildProviderSnapshot(value: unknown, provider: string): GoalProviderSessionSnapshot {
    const input = closedRecord(value, ['providerSessionId', 'recoveryMetadata', 'model'], 'session snapshot');
    const result: GoalProviderSessionSnapshot = {
        providerSessionId: providerId(input.providerSessionId, 'providerSessionId'),
        recoveryMetadata: sanitizeNewRecoveryMetadata(input.recoveryMetadata as GoalSessionJsonValue, provider),
    };
    if (input.model !== undefined) result.model = providerId(input.model, 'model');
    return result;
}

export function rebuildPauseAcknowledgement(value: unknown): GoalPauseAcknowledgement {
    const input = closedRecord(value, ['appliesAt', 'boundaryReached'], 'pause acknowledgement');
    const result: GoalPauseAcknowledgement = {
        appliesAt: closed(input.appliesAt, ['immediate', 'next_safe_boundary', 'after_turn'], 'pause boundary'),
    };
    if (input.boundaryReached !== undefined) {
        const boundary = closedRecord(input.boundaryReached, ['boundary', 'checkpointId'], 'pause boundary evidence');
        result.boundaryReached = {
            boundary: providerId(boundary.boundary, 'pause boundary'),
            checkpointId: boundary.checkpointId === undefined
                ? undefined : providerId(boundary.checkpointId, 'pause checkpoint'),
        };
    }
    return result;
}

export function rebuildMessageAcknowledgement(value: unknown): { messageId: string } {
    const input = closedRecord(value, ['messageId'], 'message acknowledgement');
    return { messageId: providerId(input.messageId, 'messageId') };
}

export function rebuildModelAcknowledgement(value: unknown): GoalModelChangeAcknowledgement {
    const input = closedRecord(value, ['outcome', 'requestedModel', 'appliesAt', 'effectiveModel'], 'model acknowledgement');
    const result: GoalModelChangeAcknowledgement = {
        requestedModel: providerId(input.requestedModel, 'requestedModel'),
        appliesAt: closed(input.appliesAt, ['immediate', 'next_safe_boundary', 'next_turn'], 'model boundary'),
    };
    if (input.outcome !== undefined) {
        result.outcome = closed(
            input.outcome, ['acknowledged', 'outside_retry_horizon'] as const, 'model outcome',
        );
    }
    if (input.effectiveModel !== undefined) result.effectiveModel = providerId(input.effectiveModel, 'effectiveModel');
    return result;
}

export function rebuildReconcileResult(value: unknown, provider: string): GoalProviderReconcileResult {
    const input = closedRecord(value, ['outcome', 'snapshot', 'reason'], 'reconciliation result');
    const outcome = closed(input.outcome, ['alive', 'resumed', 'failed'], 'reconciliation outcome');
    // Provider prose is intentionally discarded.  Public state receives only a
    // closed code-derived sentence, never a provider-controlled diagnostic.
    const reason = outcome === 'alive'
        ? 'Provider reconciliation confirmed live work'
        : outcome === 'resumed'
            ? 'Provider reconciliation resumed durable work'
            : 'Provider reconciliation failed safely';
    if (outcome === 'failed') {
        if (input.snapshot !== undefined) malformed('failed reconciliation snapshot');
        return { outcome, reason };
    }
    if (outcome === 'resumed' && input.snapshot === undefined) malformed('resumed reconciliation snapshot');
    const snapshot = input.snapshot === undefined ? undefined : rebuildProviderSnapshot(input.snapshot, provider);
    return outcome === 'resumed'
        ? { outcome, snapshot: snapshot!, reason }
        : { outcome, snapshot, reason };
}

export interface RebuiltProviderIterator {
    next(): Promise<unknown>;
    return?(): Promise<unknown>;
}

export function rebuildIterator(value: unknown): RebuiltProviderIterator {
    const iterator = closedCapability(value, 'provider iterator');
    const next = method(iterator, 'next');
    const returnMethod = optionalMethod(iterator, 'return');
    return {
        next: () => next.call(iterator),
        return: returnMethod ? () => returnMethod.call(iterator) : undefined,
    };
}

export function rebuildIteratorResult(value: unknown): IteratorResult<GoalSessionEvent> {
    const input = closedRecord(value, ['done', 'value'], 'iterator result');
    if (typeof input.done !== 'boolean') malformed('iterator done');
    if (input.done) return { done: true, value: undefined };
    if (input.value === undefined) malformed('iterator value');
    return { done: false, value: sanitizeGoalSessionEvent(input.value as GoalSessionEvent) };
}

function closedRecord(value: unknown, allowedFields: readonly string[], name: string): ClosedRecord {
    if (!value || typeof value !== 'object' || Array.isArray(value)) malformed(name);
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) malformed(name);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const allowed = new Set(allowedFields);
    if (Object.getOwnPropertySymbols(value).length > 0
        || Object.entries(descriptors).some(([key, descriptor]) =>
            !allowed.has(key) || !descriptor.enumerable || !('value' in descriptor))) malformed(name);
    const result: ClosedRecord = {};
    for (const field of allowedFields) {
        const descriptor = descriptors[field];
        if (descriptor && 'value' in descriptor) result[field] = descriptor.value;
    }
    return result;
}

function closedCapability(value: unknown, name: string): ClosedRecord {
    if (!value || typeof value !== 'object') malformed(name);
    // Iterator methods normally live on a prototype.  Reading descriptors walks
    // that chain without invoking getters; a Proxy trap remains inside the
    // provider boundary and is converted to the generic provider exception.
    return value as ClosedRecord;
}

function method(value: ClosedRecord, name: string): (...args: unknown[]) => Promise<unknown> {
    const candidate = Reflect.get(value, name);
    if (typeof candidate !== 'function') malformed(`provider ${name}`);
    return candidate as (...args: unknown[]) => Promise<unknown>;
}

function optionalMethod(value: ClosedRecord, name: string): ((...args: unknown[]) => Promise<unknown>) | undefined {
    const candidate = Reflect.get(value, name);
    if (candidate === undefined) return undefined;
    if (typeof candidate !== 'function') malformed(`provider ${name}`);
    return candidate as (...args: unknown[]) => Promise<unknown>;
}

function providerId(value: unknown, name: string): string {
    if (!isSafeIdentifier(value)) malformed(name);
    return value;
}

function closed<T extends string>(value: unknown, allowed: readonly T[], name: string): T {
    if (typeof value !== 'string' || !allowed.includes(value as T)) malformed(name);
    return value as T;
}

function malformed(name: string): never {
    throw new GoalSessionContractError(`Provider returned an invalid ${name}`, 'INVALID_PROVIDER_RESULT');
}
