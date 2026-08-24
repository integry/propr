import {
  notificationCapabilitiesResponseSchema,
  notificationPreferencesResponseSchema,
  pushSubscriptionEnrollmentResponseSchema,
  pushSubscriptionsResponseSchema,
  type NotificationCapabilitiesResponse,
  type NotificationPreferencesResponse,
  type NotificationPreferencesUpdate,
  type PushSubscriptionEnrollmentResponse,
  type PushSubscriptionInput,
  type PushSubscriptionsResponse,
} from '@propr/shared';
import { API_BASE_URL, apiFetch, handleApiResponse } from './apiClient';

const NOTIFICATIONS_URL = `${API_BASE_URL}/api/notifications`;

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
