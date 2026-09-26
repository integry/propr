import {
  notificationCapabilitiesResponseSchema,
  notificationListResponseSchema,
  notificationPreferencesResponseSchema,
  notificationStateResponseSchema,
  notificationUnreadCountResponseSchema,
  pushSubscriptionEnrollmentResponseSchema,
  pushSubscriptionsResponseSchema,
  type NotificationCapabilitiesResponse,
  type NotificationListResponse,
  type NotificationPreferencesResponse,
  type NotificationPreferencesUpdate,
  type NotificationStateResponse,
  type NotificationUnreadCountResponse,
  type PushSubscriptionEnrollmentResponse,
  type PushSubscriptionInput,
  type PushSubscriptionsResponse,
} from '@propr/shared';
import { API_BASE_URL, apiFetch, handleApiResponse } from './apiClient';

const NOTIFICATIONS_URL = `${API_BASE_URL}/api/notifications`;

export interface ListNotificationsOptions {
  cursor?: string;
  limit?: number;
}

export class PushSubscriptionOwnershipConflictError extends Error {
  constructor() {
    super('This browser subscription belongs to another signed-in account.');
    this.name = 'PushSubscriptionOwnershipConflictError';
  }
}

async function requestJson<T>(
  path: string,
  schema: { parse(value: unknown): T },
  init?: RequestInit,
): Promise<T> {
  const response = await apiFetch(`${NOTIFICATIONS_URL}${path}`, {
    credentials: 'include',
    ...init,
  }, {
    // Every notification mutation here is an idempotent upsert, patch, or
    // revocation and can safely be replayed after an auth-token refresh.
    replayMutationAfterTokenRefresh: init?.method !== undefined,
  });
  await handleApiResponse(response);
  return schema.parse(await response.json() as unknown);
}

export function getNotificationCapabilities(): Promise<NotificationCapabilitiesResponse> {
  return requestJson('/config', notificationCapabilitiesResponseSchema);
}

export function listNotifications(
  options: ListNotificationsOptions = {},
): Promise<NotificationListResponse> {
  const query = new URLSearchParams();
  if (options.cursor) query.set('cursor', options.cursor);
  if (options.limit !== undefined) query.set('limit', String(options.limit));
  const suffix = query.size > 0 ? `?${query.toString()}` : '';
  return requestJson(suffix, notificationListResponseSchema);
}

export function getNotificationUnreadCount(): Promise<NotificationUnreadCountResponse> {
  return requestJson('/unread-count', notificationUnreadCountResponseSchema);
}

export function markNotificationRead(id: string): Promise<NotificationStateResponse> {
  return requestJson(`/${encodeURIComponent(id)}/read`, notificationStateResponseSchema, {
    method: 'POST',
  });
}

export function dismissNotification(id: string): Promise<NotificationStateResponse> {
  return requestJson(`/${encodeURIComponent(id)}/dismiss`, notificationStateResponseSchema, {
    method: 'POST',
  });
}

export function dismissAllNotifications(): Promise<NotificationUnreadCountResponse> {
  return requestJson('/dismiss-all', notificationUnreadCountResponseSchema, {
    method: 'POST',
  });
}

export function getNotificationPreferences(): Promise<NotificationPreferencesResponse> {
  return requestJson('/preferences', notificationPreferencesResponseSchema);
}

export function updateNotificationPreferences(
  update: NotificationPreferencesUpdate,
): Promise<NotificationPreferencesResponse> {
  return requestJson('/preferences', notificationPreferencesResponseSchema, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(update),
  });
}

export async function registerPushSubscription(
  subscription: PushSubscriptionInput,
): Promise<PushSubscriptionEnrollmentResponse> {
  const response = await apiFetch(`${NOTIFICATIONS_URL}/push-subscriptions`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(subscription),
  }, { replayMutationAfterTokenRefresh: true });
  if (response.status === 409) {
    const body = await response.clone().json().catch(() => null) as { code?: unknown } | null;
    if (body?.code === 'PUSH_SUBSCRIPTION_CONFLICT') {
      throw new PushSubscriptionOwnershipConflictError();
    }
  }
  await handleApiResponse(response);
  return pushSubscriptionEnrollmentResponseSchema.parse(await response.json() as unknown);
}

export function listPushSubscriptions(): Promise<PushSubscriptionsResponse> {
  return requestJson('/push-subscriptions', pushSubscriptionsResponseSchema);
}

export async function revokePushSubscription(endpoint: string): Promise<void> {
  const response = await apiFetch(`${NOTIFICATIONS_URL}/push-subscriptions`, {
    method: 'DELETE',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint }),
  }, { replayMutationAfterTokenRefresh: true });
  await handleApiResponse(response);
}
