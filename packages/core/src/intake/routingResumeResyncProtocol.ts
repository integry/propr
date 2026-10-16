/**
 * Wire contract for the versioned `installation_resume_resync_v1` routing
 * capability.
 *
 * Routing may suspend a GitHub App installation after a long streak of GitHub
 * activity that no ProPR client consumed. While an installation is suspended
 * GitHub blocks both API access and webhook delivery, so reconnecting cannot
 * simply continue: this Core must reconcile current GitHub state across the
 * missed interval and acknowledge the exact resume generation it reconciled.
 * Routing only enforces suspension for clients that advertised this capability
 * in their authenticated `hello`; a client that never advertises it keeps the
 * legacy behavior.
 *
 * Relay -> backend control frames (all carry `version: 1`):
 *   - `resume_pending`: the installation is (or was) suspended. Carries the
 *     installation, its routing generation, the resume generation and the gap
 *     start. GitHub is still unreachable, so the backend only records it.
 *   - `resync_required`: the installation was unsuspended. Adds the gap end.
 *     The backend reconciles every tracked repository, then answers with
 *     `resync_complete` for exactly this generation. Routing keeps the
 *     installation in `resync_required` (and keeps caching post-resume events)
 *     until it accepts that completion.
 *   - `resync_accepted`: Routing accepted the completion identified by
 *     `completionId` for this generation; cached events replay afterwards.
 *
 * Backend -> relay:
 *   - `resync_complete`: exact-generation completion with bounded, non-secret
 *     evidence. Re-sent byte-for-byte (same `completionId`) until accepted.
 *
 * Frames are validated strictly: a frame carrying any field outside its type's
 * exact shape is rejected (`unknown_field`), and accepted frames are copied into
 * new objects so nothing from the relay reaches persistence, status, or logs.
 */

import { isAccountStatusTimestamp } from '@propr/shared';

/** Capability advertised in the routing `hello` when resume resync is supported. */
export const INSTALLATION_RESUME_RESYNC_CAPABILITY = 'installation_resume_resync_v1';

/** Version of the resume-resync control frames this Core understands. */
export const RESUME_RESYNC_FRAME_VERSION = 1;

/** Control frames are tiny; reject padded or oversized frames outright. */
export const MAX_RESUME_RESYNC_FRAME_BYTES = 4 * 1024;

/** Bound for the opaque completion identity echoed by `resync_accepted`. */
const MAX_COMPLETION_ID_LENGTH = 128;

export const RESUME_RESYNC_FRAME_TYPES = ['resume_pending', 'resync_required', 'resync_accepted'] as const;
export type ResumeResyncFrameType = (typeof RESUME_RESYNC_FRAME_TYPES)[number];

export function isResumeResyncFrameType(type: unknown): type is ResumeResyncFrameType {
    return typeof type === 'string' && (RESUME_RESYNC_FRAME_TYPES as readonly string[]).includes(type);
}

/** The exact generation a resume-resync frame or record refers to. */
export interface ResumeGenerationIdentity {
    installationId: number;
    /** Installation/routing incarnation; a reinstall or routing reset increments it. */
    routingGeneration: number;
    /** Monotonic suspension/resume counter within one routing generation. */
    resumeGeneration: number;
}

export interface ResumePendingFrame extends ResumeGenerationIdentity {
    type: 'resume_pending';
    gapStartedAt: string;
}

export interface ResyncRequiredFrame extends ResumeGenerationIdentity {
    type: 'resync_required';
    gapStartedAt: string;
    gapEndedAt: string;
}

export interface ResyncAcceptedFrame extends ResumeGenerationIdentity {
    type: 'resync_accepted';
    completionId: string;
}

export type ResumeResyncFrame = ResumePendingFrame | ResyncRequiredFrame | ResyncAcceptedFrame;

export type ResumeResyncFrameParseResult =
    | { ok: true; frame: ResumeResyncFrame }
    | { ok: false; reason: string };

/** Bounded, non-secret evidence carried by `resync_complete`. */
export interface ResyncCompletionEvidence {
    /**
     * `reconciled`: accessible and configured; `inaccessible`: access lost, local
     * work invalidated; `unconfigured`: accessible but no longer configured,
     * local work invalidated. They sum to `total`.
     */
    repositories: { total: number; reconciled: number; inaccessible: number; unconfigured: number };
    /** Reconciliation families settled (run, or inapplicable with evidence) for every repository. */
    families: string[];
    /** Reconciliation attempts this generation needed. */
    attempts: number;
    /** SHA-256 over the sorted per-repository outcomes; names stay local. */
    digest: string;
}

/** The persisted completion identity; resent unchanged until Routing accepts it. */
export interface ResyncCompletion {
    completionId: string;
    completedAt: string;
    evidence: ResyncCompletionEvidence;
}

const IDENTITY_FIELDS = ['type', 'version', 'installationId', 'routingGeneration', 'resumeGeneration'];
const FRAME_FIELDS: Record<ResumeResyncFrameType, readonly string[]> = {
    resume_pending: [...IDENTITY_FIELDS, 'gapStartedAt'],
    resync_required: [...IDENTITY_FIELDS, 'gapStartedAt', 'gapEndedAt'],
    resync_accepted: [...IDENTITY_FIELDS, 'completionId'],
};

/** JSON never decodes to `undefined`, so an undefined-valued key is an absent one. */
function hasUnknownField(frame: Record<string, unknown>, allowed: readonly string[]): boolean {
    return Object.keys(frame).some(key => frame[key] !== undefined && !allowed.includes(key));
}

function isPositiveSafeInteger(value: unknown): value is number {
    return Number.isSafeInteger(value) && (value as number) > 0;
}

function parseIdentity(frame: Record<string, unknown>): ResumeGenerationIdentity | string {
    if (!isPositiveSafeInteger(frame.installationId)) return 'invalid_installation_id';
    if (!isPositiveSafeInteger(frame.routingGeneration)) return 'invalid_routing_generation';
    if (!isPositiveSafeInteger(frame.resumeGeneration)) return 'invalid_resume_generation';
    return {
        installationId: frame.installationId,
        routingGeneration: frame.routingGeneration,
        resumeGeneration: frame.resumeGeneration,
    };
}

function parseGap(frame: Record<string, unknown>, requireEnd: boolean): { gapStartedAt: string; gapEndedAt?: string } | string {
    if (!isAccountStatusTimestamp(frame.gapStartedAt)) return 'invalid_gap_started_at';
    if (!requireEnd) return { gapStartedAt: frame.gapStartedAt };
    if (!isAccountStatusTimestamp(frame.gapEndedAt)) return 'invalid_gap_ended_at';
    if (Date.parse(frame.gapEndedAt) < Date.parse(frame.gapStartedAt)) return 'gap_ends_before_start';
    return { gapStartedAt: frame.gapStartedAt, gapEndedAt: frame.gapEndedAt };
}

/**
 * Strictly validate a decoded resume-resync control frame. A frame that fails
 * any check is rejected as a whole (fail closed) with a machine-readable reason;
 * the caller records the rejection and changes no state.
 */
export function parseResumeResyncFrame(frame: Record<string, unknown>, frameBytes: number): ResumeResyncFrameParseResult {
    if (!isResumeResyncFrameType(frame.type)) return { ok: false, reason: 'unknown_type' };
    if (frameBytes > MAX_RESUME_RESYNC_FRAME_BYTES) return { ok: false, reason: 'oversized_frame' };
    if (frame.version !== RESUME_RESYNC_FRAME_VERSION) return { ok: false, reason: 'unsupported_version' };
    if (frame.type === 'resume_pending' && frame.gapEndedAt !== undefined) return { ok: false, reason: 'unexpected_gap_ended_at' };
    if (hasUnknownField(frame, FRAME_FIELDS[frame.type])) return { ok: false, reason: 'unknown_field' };
    const identity = parseIdentity(frame);
    if (typeof identity === 'string') return { ok: false, reason: identity };

    if (frame.type === 'resync_accepted') {
        const completionId = frame.completionId;
        if (typeof completionId !== 'string' || completionId.length === 0 || completionId.length > MAX_COMPLETION_ID_LENGTH) {
            return { ok: false, reason: 'invalid_completion_id' };
        }
        return { ok: true, frame: { type: 'resync_accepted', ...identity, completionId } };
    }

    const gap = parseGap(frame, frame.type === 'resync_required');
    if (typeof gap === 'string') return { ok: false, reason: gap };
    if (frame.type === 'resume_pending') {
        return { ok: true, frame: { type: 'resume_pending', ...identity, gapStartedAt: gap.gapStartedAt } };
    }
    return {
        ok: true,
        frame: { type: 'resync_required', ...identity, gapStartedAt: gap.gapStartedAt, gapEndedAt: gap.gapEndedAt as string },
    };
}

/** Build the exact-generation `resync_complete` frame from persisted state. */
export function buildResyncCompleteFrame(
    identity: ResumeGenerationIdentity,
    gap: { gapStartedAt: string; gapEndedAt: string },
    completion: ResyncCompletion,
): Record<string, unknown> {
    return {
        type: 'resync_complete',
        version: RESUME_RESYNC_FRAME_VERSION,
        installationId: identity.installationId,
        routingGeneration: identity.routingGeneration,
        resumeGeneration: identity.resumeGeneration,
        completionId: completion.completionId,
        gapStartedAt: gap.gapStartedAt,
        gapEndedAt: gap.gapEndedAt,
        completedAt: completion.completedAt,
        evidence: {
            repositories: { ...completion.evidence.repositories },
            families: [...completion.evidence.families],
            attempts: completion.evidence.attempts,
            digest: completion.evidence.digest,
        },
    };
}

/** Compare two generations: negative when `a` is older than `b`. */
export function compareGenerations(a: ResumeGenerationIdentity, b: ResumeGenerationIdentity): number {
    if (a.routingGeneration !== b.routingGeneration) return a.routingGeneration - b.routingGeneration;
    return a.resumeGeneration - b.resumeGeneration;
}
