import {
  ACTIVITY_UPDATE,
  GOAL_UPDATE,
  NOTIFICATION_UPDATE,
  USAGE_UPDATE,
  isActivityTimestamp,
  isActivityUpdatePayload,
  isGoalUpdatePayload,
  isNotificationUpdatePayload,
  isTerminalActivityChange,
  isUsageUpdatePayload,
  type ActivityChange,
  type ActivityUpdatePayload,
  type DraftUpdatePayload,
  type GoalActivityState,
  type GoalUpdatePayload,
  type NotificationChange,
  type NotificationUpdatePayload,
  type TaskUpdatePayload,
  type UsageUpdatePayload,
} from '@propr/shared';
import { userRoom } from './socketSubscriptions.js';

/**
 * Turns producer events into the general activity envelope and into socket
 * frames.
 *
 * This is a module of its own rather than more code inside socketService so the
 * derivation rules - what counts as terminal, what is repository-scoped, which
 * room a frame belongs in - can be unit-tested without standing up Socket.IO,
 * and so socketService keeps owning only connection lifecycle.
 *
 * `ACTIVITY_UPDATE` is derived here instead of being published by every
 * producer because tasks and planner drafts already publish from many call
 * sites (WorkerStateManager, traceService, planner handlers, PR comment jobs).
 * Asking each of them to publish a second event guarantees drift: some path
 * would publish one and not the other. Deriving in the one layer that already
 * subscribes makes 'a task changed' and 'activity happened' the same fact by
 * construction.
 */

/** Room every consumer of instance-wide activity joins. */
export const ACTIVITY_ROOM = 'activity';

/**
 * Worker lifecycle states, mapped onto the activity vocabulary.
 *
 * This is the only place the mapping lives. Consumers ask 'did something
 * complete' rather than matching state strings, so adding a worker state does
 * not mean editing every widget.
 */
const TASK_STATE_CHANGE: Record<string, ActivityChange> = {
  pending: 'created',
  queued: 'created',
  processing: 'started',
  claude_execution: 'progressed',
  post_processing: 'progressed',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
};

const GOAL_STATE_CHANGE: Record<GoalActivityState, ActivityChange> = {
  queued: 'created',
  running: 'started',
  paused: 'progressed',
  blocked: 'blocked',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
};

const NOTIFICATION_ACTIVITY_CHANGE: Record<NotificationChange, ActivityChange> = {
  created: 'created',
  read: 'read',
  dismissed: 'dismissed',
  // A bulk clear has no single subject; consumers treat it as a dismissal of
  // the entity named 'all' and reconcile the list.
  dismissed_all: 'dismissed',
};

function activity(
  fields: Omit<ActivityUpdatePayload, 'eventType' | 'terminal'>,
): ActivityUpdatePayload {
  return {
    eventType: ACTIVITY_UPDATE,
    // Precomputed once here rather than in every consumer, so 'terminal' cannot
    // come to mean different things on the dashboard and in the summary widget.
    terminal: isTerminalActivityChange(fields.change),
    ...fields,
  };
}

/** The activity envelope for a task state change, or null when the state is unknown. */
export function activityFromTask(payload: TaskUpdatePayload): ActivityUpdatePayload | null {
  const change = TASK_STATE_CHANGE[payload.state];
  // An unmapped state is dropped rather than guessed: a wrong 'completed' would
  // make a summary consumer claim work finished that has not.
  if (!change) return null;
  return activity({
    domain: 'task',
    change,
    entityId: payload.taskId,
    repository: payload.repository ?? null,
    occurredAt: payload.timestamp,
    ...(payload.version === undefined ? {} : { revision: payload.version }),
  });
}

export function activityFromDraft(payload: DraftUpdatePayload): ActivityUpdatePayload {
  const change: ActivityChange = payload.draftStatus === 'review'
    ? 'completed'
    : payload.draftStatus === 'failed'
      ? 'failed'
      : 'progressed';
  return activity({
    domain: 'plan',
    change,
    entityId: payload.draftId,
    // Draft updates carry no repository; a consumer that filters by repository
    // resolves it from the draft it already reads rather than being told a guess.
    repository: null,
    occurredAt: payload.timestamp,
  });
}

export function activityFromGoal(payload: GoalUpdatePayload): ActivityUpdatePayload {
  return activity({
    domain: 'goal',
    change: GOAL_STATE_CHANGE[payload.state] ?? 'progressed',
    entityId: payload.goalId,
    repository: payload.repository,
    occurredAt: payload.occurredAt,
    ...(payload.revision === undefined ? {} : { revision: payload.revision }),
  });
}

export function activityFromNotification(
  payload: NotificationUpdatePayload,
): ActivityUpdatePayload {
  return activity({
    domain: 'notification',
    change: NOTIFICATION_ACTIVITY_CHANGE[payload.change] ?? 'progressed',
    entityId: payload.eventId ?? 'all',
    repository: payload.repository,
    occurredAt: payload.occurredAt,
  });
}

/** The narrow slice of a Socket.IO server this broadcaster needs. */
export interface ActivityEmitter {
  to: (room: string) => { emit: (event: string, payload: unknown) => void };
}

/** Where dropped frames are reported. Replaced in tests. */
export interface ActivityBroadcastLog {
  warn: (message: string) => void;
}

/**
 * Emits the new activity surface onto Socket.IO rooms.
 *
 * Stateless by design: the Redis subscription it is fed from is the one
 * socketService already owns and already tears down, so there is no second
 * connection to leak on shutdown.
 */
export class ActivityBroadcaster {
  constructor(
    private readonly io: ActivityEmitter,
    private readonly log: ActivityBroadcastLog = console,
  ) {}

  /**
   * Validate at the trust boundary. These frames are decoded from Redis and
   * re-emitted to browsers, so a malformed publish is dropped and reported here
   * rather than forwarded into every consumer's switch statement.
   */
  private emitActivity(payload: ActivityUpdatePayload | null, room = ACTIVITY_ROOM): void {
    if (!payload) return;
    const { domain } = payload;
    if (!isActivityUpdatePayload(payload)) {
      this.log.warn(`[activity] Dropped a malformed ${domain} activity envelope`);
      return;
    }
    this.io.to(room).emit(ACTIVITY_UPDATE, payload);
  }

  /**
   * Accept a producer frame only if it satisfies its whole published contract.
   *
   * The Redis decode hands `handleEvent` an untyped object that a cast claims
   * is a payload, so this is the only place the claim is checked. A frame that
   * fails here is dropped before either the producer's own event or anything
   * derived from it reaches a browser: forwarding half a contract is what turns
   * one bad publish into a consumer reading `undefined.state`.
   */
  private accepts<T>(
    payload: unknown,
    guard: (value: unknown) => value is T,
    event: string,
  ): payload is T {
    // Reported separately because an unorderable frame is the failure an
    // operator is most likely to see from a clock or serialization bug.
    if (!isActivityTimestamp((payload as { occurredAt?: unknown } | null)?.occurredAt)) {
      this.log.warn(`[activity] Dropped ${event} frame without a parseable occurredAt`);
      return false;
    }
    if (!guard(payload)) {
      this.log.warn(`[activity] Dropped malformed ${event} frame`);
      return false;
    }
    return true;
  }

  /** Derive activity from a task update that has already passed its ordering gate. */
  taskUpdated(payload: TaskUpdatePayload): void {
    this.emitActivity(activityFromTask(payload));
  }

  /**
   * Derive activity from a planner draft update.
   *
   * Scoped to the draft's owner, not the instance-wide activity room: drafts are
   * per-user records and `DRAFT_UPDATE` itself is already owner-scoped. Widening
   * that here would tell every connected operator which drafts exist.
   */
  draftUpdated(payload: DraftUpdatePayload, ownerId: string): void {
    this.emitActivity(activityFromDraft(payload), userRoom(ownerId));
  }

  /**
   * Emit the goal-shaped event the Goals console wants plus the generic envelope
   * the dashboard and a summary widget want. Both describe the same transition;
   * exactly one of each is emitted per published transition.
   */
  goalUpdated(payload: unknown): void {
    if (!this.accepts(payload, isGoalUpdatePayload, GOAL_UPDATE)) return;
    this.io.to(ACTIVITY_ROOM).emit(GOAL_UPDATE, payload);
    this.emitActivity(activityFromGoal(payload));
  }

  /**
   * Fan a notification change out to its recipients, envelope included.
   *
   * Each recipient's frame names only that recipient, so one user can neither
   * receive another user's notification events nor learn who else was notified.
   * The derived envelope stays inside those same rooms rather than going
   * instance-wide: dropping `recipientIds` from it does not make it public
   * information, because it still says that this event id, on this repository,
   * was delivered to or acted on by someone. The instance-wide activity room is
   * joined by any authenticated socket, so emitting there would hand every user
   * the arrival and the read/dismiss timing of notifications addressed to
   * someone else. A notification is the one activity domain whose audience is
   * its recipients, so that is the only audience its activity has.
   */
  notificationUpdated(payload: unknown): void {
    if (!this.accepts(payload, isNotificationUpdatePayload, NOTIFICATION_UPDATE)) return;
    const { recipientIds, ...forClient } = payload;
    // The list is an array by now, but a single unusable entry addresses no
    // room and must not cost the other recipients their frame.
    const recipients = recipientIds.filter(
      (userId): userId is string => typeof userId === 'string' && userId !== '',
    );
    const envelope = activityFromNotification(payload);
    for (const userId of new Set(recipients)) {
      this.io.to(userRoom(userId)).emit(NOTIFICATION_UPDATE, {
        ...forClient,
        recipientIds: [userId],
      });
      this.emitActivity(envelope, userRoom(userId));
    }
  }

  /**
   * Relay the bare usage trigger; the client re-reads the usage endpoint.
   *
   * No activity envelope is derived from it: usage is a capacity reading rather
   * than a unit of work, and a summary consumer regenerating on it would be
   * reacting to nothing having happened.
   */
  usageUpdated(payload: unknown): void {
    if (!this.accepts(payload, isUsageUpdatePayload, USAGE_UPDATE)) return;
    this.io.to(ACTIVITY_ROOM).emit(USAGE_UPDATE, payload);
  }
}
