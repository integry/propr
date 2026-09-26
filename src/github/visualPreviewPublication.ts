import { parsePreviewArtifactV1 } from '@propr/shared';
import { redactVisualPreviewPaths, type VisualPreviewEvidence } from '@propr/core';
import type { ManagedVisualPreviewAssetResult, ManagedVisualPreviewContext } from './managedVisualPreviewStorage.js';

export function publicPreviewText(text: string, evidence: VisualPreviewEvidence): string {
  for (const asset of evidence.assets) {
    if (/^https:\/\//.test(asset.absolutePath)) continue;
    for (const local of [asset.absolutePath, encodeURI(asset.absolutePath), encodeURIComponent(asset.absolutePath)]) {
      text = text.replaceAll(local, '[local preview omitted]');
    }
  }
  return redactVisualPreviewPaths(text);
}


/** Recheck retention and ownership at publication, independently of remote responses. */
export function publishedOriginal(result: ManagedVisualPreviewAssetResult | undefined, context: ManagedVisualPreviewContext) {
  const artifact = result?.stored
    ? parsePreviewArtifactV1(result.artifact, process.env.PROPR_CONNECT_URL ?? 'https://connect.propr.dev')
    : undefined;
  return artifact && Date.parse(artifact.retentionExpiresAt) > Date.now()
    && artifact.taskId === context.taskId && artifact.repository === context.repository
    && artifact.pullRequestNumber === context.pullRequestNumber ? artifact : undefined;
}

export function originalUnavailableText(result: ManagedVisualPreviewAssetResult | undefined): string {
  return result && !result.stored && result.code === 'quota_exceeded'
    ? 'Original unavailable: managed storage quota exceeded.'
    : 'Original unavailable: managed storage is unavailable or the upload has expired.';
}
