export {
  NotificationService,
  NotificationEventNotFoundError,
  NotificationValidationError,
  PushSubscriptionConflictError,
  PushSubscriptionQuotaError,
  PushSubscriptionRateLimitError,
  MAX_ACTIVE_PUSH_SUBSCRIPTIONS_PER_USER,
  MAX_STORED_PUSH_SUBSCRIPTIONS_PER_USER,
  MAX_PUSH_SUBSCRIPTION_ENROLLMENTS_PER_WINDOW,
  PUSH_SUBSCRIPTION_ENROLLMENT_WINDOW_MS,
  PUSH_SUBSCRIPTION_REVOKED_RETENTION_MS,
  PUSH_SUBSCRIPTION_GC_BATCH_SIZE,
  notificationService,
  createNotificationEvent,
  assignNotificationRecipients,
  listNotifications,
  getUnreadNotificationCount,
  markNotificationRead,
  dismissNotification,
  getNotificationPreferences,
  updateNotificationPreferences,
  updateNotificationPreference,
  upsertPushSubscription,
  listPushSubscriptions,
  revokePushSubscription,
  revokePushSubscriptionById,
  garbageCollectPushSubscriptions
} from './services/notificationService.js';
export type {
  NotificationRecipientInput,
  NotificationRecipient,
  CreateNotificationEventInput,
  NotificationListOptions,
  NotificationServiceOptions
} from './services/notificationService.js';
export {
  NotificationProjectionService,
  notificationProjectionService,
  projectNotificationUpdateBestEffort
} from './services/notificationProjectionService.js';
export type {
  NotificationProjectionOutcome,
  NotificationProjectionServiceOptions
} from './services/notificationProjectionService.js';
export { recordNotificationInstanceEligibility }
  from './services/notificationInstanceEligibility.js';
export {
  DEFAULT_NOTIFICATION_INDEXING_TRANSITION_RETENTION_MS,
  getNotificationIndexingTransitionRetentionMs
} from './services/notificationProjectionReconciliationValues.js';
export {
  NotificationSystemProjection,
  notificationSystemProjection,
  projectSystemSnapshotBestEffort
} from './services/notificationSystemProjection.js';
export type {
  NotificationSystemProjectionOptions,
  SystemStatusSnapshot
} from './services/notificationSystemProjection.js';
export {
  NotificationSystemSampler,
  DEFAULT_NOTIFICATION_SYSTEM_CHECK_INTERVAL_MS,
  DEFAULT_NOTIFICATION_SYSTEM_STARTUP_GRACE_MS,
  DEFAULT_NOTIFICATION_OPERATION_TIMEOUT_MS,
  DEFAULT_NOTIFICATION_SHUTDOWN_DRAIN_MS,
  MIN_NOTIFICATION_LEASE_RENEWAL_INTERVAL_MS,
  getNotificationProjectionLeaseTtlMs,
  getNotificationSystemCheckIntervalMs,
  getNotificationSystemStartupGraceMs
} from './services/notificationSystemSampler.js';
export type { NotificationProjectionLease }
  from './services/notificationLeaseRunner.js';
export type { NotificationSystemSamplerOptions }
  from './services/notificationSystemSampler.js';
export {
  NotificationStalledDetector,
  DEFAULT_NOTIFICATION_STALLED_AFTER_MS,
  DEFAULT_NOTIFICATION_STALLED_CHECK_INTERVAL_MS,
  getNotificationStalledAfterMs,
  getNotificationStalledCheckIntervalMs
} from './services/notificationStalledDetector.js';
export type { NotificationStalledDetectorOptions }
  from './services/notificationStalledDetector.js';
export {
  MAX_NOTIFICATION_TIMER_DELAY_MS,
  NotificationOperationTimeoutError,
  isNotificationTimerDelay,
  settlesWithin,
  withNotificationDeadline
} from './services/notificationSchedulerTiming.js';
export {
  DEFAULT_NOTIFICATION_REPOSITORY_ENTITLEMENT_TTL_MS,
  getNotificationRepositoryEntitlementTtlMs,
  replaceNotificationRepositoryEntitlements,
  replaceNotificationRepositorySubscriptions
} from './services/notificationRepositoryAccess.js';
export type { NotificationRepositoryEntitlementFence }
  from './services/notificationRepositoryAccess.js';
export {
  DEFAULT_NOTIFICATION_LIST_LIMIT,
  MAX_NOTIFICATION_LIST_LIMIT,
  NotificationQueryValidationError,
  parseNotificationListLimit,
  encodeNotificationCursor,
  decodeNotificationCursor
} from './services/notificationPagination.js';
export type { NotificationCursor } from './services/notificationPagination.js';
