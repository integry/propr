import { trustedPreviewMedia } from '@propr/shared';
import { API_BASE_URL, apiFetch, handleApiResponse } from './apiClient';

export async function getRepositoryMedia(repository: string, offset = 0) {
  const query = new URLSearchParams({ repository, offset: String(offset) });
  const response = await apiFetch(`${API_BASE_URL}/api/repos/media?${query}`, { credentials: 'include' });
  await handleApiResponse(response);
  const data = await response.json();
  return { previews: trustedPreviewMedia(data.previews, Number.MAX_SAFE_INTEGER), unavailable: data.unavailable === true,
    nextOffset: Number.isSafeInteger(data.nextOffset) && data.nextOffset > offset ? data.nextOffset as number : null };
}
