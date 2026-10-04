import { MAX_SELECTED_USAGE_TIPS, USAGE_TIPS_BY_ID, type UsageTipsResponse } from '@propr/shared';
import { API_BASE_URL, apiFetch, handleApiResponse } from './apiClient';

export const USAGE_TIPS_SETTINGS_CHANGED = 'propr:usage-tips-settings-changed';
export async function getUsageTips(): Promise<UsageTipsResponse> {
  const response = await apiFetch(`${API_BASE_URL}/api/usage-tips`, { credentials: 'include', cache: 'no-store' });
  await handleApiResponse(response);
  const result = await response.json() as UsageTipsResponse;
  if (typeof result.enabled !== 'boolean' || !Array.isArray(result.tips)) throw new Error('Invalid usage tips');
  return { enabled: result.enabled, tips: result.enabled ? result.tips.filter(t => t && USAGE_TIPS_BY_ID.has(t.id)
    && typeof t.body === 'string' && t.body.trim().length > 0 && t.body.length <= 240)
    .slice(0, MAX_SELECTED_USAGE_TIPS).map(t => ({ ...USAGE_TIPS_BY_ID.get(t.id)!, body: t.body.trim() })) : [] };
}
export async function dismissUsageTip(tipId: string, eventId: string): Promise<void> {
  const response = await apiFetch(`${API_BASE_URL}/api/usage-tips/dismiss`, {
    method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tipId, eventId }), signal: AbortSignal.timeout(15_000),
  }, { replayMutationAfterTokenRefresh: true });
  await handleApiResponse(response);
}
