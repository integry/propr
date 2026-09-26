import {
  trustedGitHubAttachmentUrl,
  parsePreviewArtifactV1,
  sanitizePreviewDisplayFilename,
  VISUAL_PREVIEW_CONTENT_TYPES,
  type PreviewArtifactV1,
} from '@propr/shared';
import path from 'node:path';
import type { VisualPreviewAsset, VisualPreviewEvidence } from './visualPreviewService.js';

export const VISUAL_PREVIEW_MARKER = '<!-- propr-visual-preview -->';
export const VISUAL_PREVIEW_SLOT = '<!-- propr-visual-preview-slot -->';

export interface RenderVisualPreviewOptions {
  useLocalPaths?: boolean;
  published?: PublishedVisualPreviewMetadata;
}

export interface PublishedVisualPreviewAssetInput {
  assetIndex: number;
  relativePath: string;
  githubAttachmentUrl?: string;
  managedOriginal?: PreviewArtifactV1;
  unavailableReason?: 'github-inline-failed' | 'github-authentication-failed' | 'github-inline-limit';
}

export interface CreatePublishedVisualPreviewMetadataOptions {
  taskId: string;
  repository: string;
  pullRequestNumber?: number;
  trustedConnectOrigin: string;
  assets: readonly PublishedVisualPreviewAssetInput[];
}

interface PublishedVisualPreviewAsset {
  assetIndex: number;
  relativePath: string;
  githubAttachmentUrl?: string;
  managedViewerUrl?: string;
  unavailableReason?: PublishedVisualPreviewAssetInput['unavailableReason'];
}

const publishedMetadataBrand = Symbol('PublishedVisualPreviewMetadata');

/** Opaque, validated publication data. Renderers never consume URL-shaped agent or manifest fields. */
export interface PublishedVisualPreviewMetadata {
  readonly [publishedMetadataBrand]: true;
  readonly assets: readonly PublishedVisualPreviewAsset[];
}

export { trustedGitHubAttachmentUrl } from '@propr/shared';

export function createPublishedVisualPreviewMetadata(
  evidence: VisualPreviewEvidence,
  options: CreatePublishedVisualPreviewMetadataOptions,
): PublishedVisualPreviewMetadata {
  const seen = new Set<number>();
  const assets = options.assets.flatMap(input => {
    if (!Number.isSafeInteger(input.assetIndex) || input.assetIndex < 0 || seen.has(input.assetIndex)) return [];
    const asset = evidence.assets[input.assetIndex];
    if (!asset || input.relativePath !== asset.relativePath) return [];
    seen.add(input.assetIndex);

    const githubAttachmentUrl = trustedGitHubAttachmentUrl(input.githubAttachmentUrl);
    const managedOriginal = input.managedOriginal
      ? parsePreviewArtifactV1(input.managedOriginal, options.trustedConnectOrigin)
      : undefined;
    const contentType = VISUAL_PREVIEW_CONTENT_TYPES[path.extname(asset.relativePath).toLowerCase()];
    const expectedFilename = sanitizePreviewDisplayFilename(path.basename(asset.relativePath));
    const trustedManagedOriginal = managedOriginal
      && managedOriginal.taskId === options.taskId
      && managedOriginal.repository === options.repository
      && managedOriginal.pullRequestNumber === options.pullRequestNumber
      && managedOriginal.displayFilename === expectedFilename
      && managedOriginal.contentType === contentType
      && (asset.sizeBytes === undefined || managedOriginal.sizeBytes === asset.sizeBytes)
      ? managedOriginal
      : undefined;

    return [{
      assetIndex: input.assetIndex,
      relativePath: input.relativePath,
      ...(githubAttachmentUrl ? { githubAttachmentUrl } : {}),
      ...(trustedManagedOriginal ? { managedViewerUrl: trustedManagedOriginal.viewerUrl } : {}),
      ...(input.unavailableReason ? { unavailableReason: input.unavailableReason } : {}),
    }];
  });
  return { [publishedMetadataBrand]: true, assets };
}

function markdownText(value: string): string {
  return value.replace(/([\\`*_[\]{}()<>#+.!|])/g, '\\$1');
}

function markdownTarget(target: string): string {
  return /[\s()]/.test(target) ? `<${target.replaceAll('>', '%3E')}>` : target;
}

function appendLocalAsset(parts: string[], asset: VisualPreviewAsset): void {
  parts.push(`### ${markdownText(asset.title)}`);
  parts.push(`![${asset.type === 'image' ? markdownText(asset.title) : ''}](${markdownTarget(asset.absolutePath)})`);
  if (asset.description) parts.push(markdownText(asset.description));
}

function unavailableMessage(item: PublishedVisualPreviewAsset): string | undefined {
  if (item.unavailableReason === 'github-authentication-failed') {
    return item.managedViewerUrl
      ? 'The GitHub inline attachment could not be published; the authenticated original remains available above.'
      : 'The preview could not be uploaded to GitHub.';
  }
  if (item.unavailableReason === 'github-inline-failed') {
    return item.managedViewerUrl
      ? 'The GitHub inline attachment could not be published; the authenticated original remains available above.'
      : 'The preview could not be uploaded to GitHub.';
  }
  if (item.unavailableReason === 'github-inline-limit' && !item.managedViewerUrl) {
    return 'This preview could not be published to managed storage and does not fit the resolved GitHub inline limit.';
  }
  return undefined;
}

function appendPublishedAsset(
  parts: string[],
  evidence: VisualPreviewEvidence,
  item: PublishedVisualPreviewAsset,
): void {
  const asset = evidence.assets[item.assetIndex];
  if (!asset) return;
  parts.push(`### ${markdownText(asset.title)}`);
  if (item.githubAttachmentUrl) {
    parts.push(`![${asset.type === 'image' ? markdownText(asset.title) : ''}](${item.githubAttachmentUrl})`);
  }
  if (asset.description) parts.push(markdownText(asset.description));
  if (item.managedViewerUrl) {
    parts.push(`[View the full-resolution original in ProPR Connect](${item.managedViewerUrl})`);
  }
  const message = unavailableMessage(item);
  if (message) parts.push(message);
}

function appendToolSuggestions(parts: string[], evidence: VisualPreviewEvidence): void {
  if (evidence.toolSuggestions.length === 0) return;
  parts.push('### Suggested agent tools');
  parts.push(evidence.toolSuggestions
    .map(suggestion => `- **${markdownText(suggestion.name)}:** ${markdownText(suggestion.reason)}`)
    .join('\n'));
}

function appendRestorePreviewUploadsGuidance(parts: string[]): void {
  parts.push('### Restore preview uploads');
  parts.push(
    'An instance administrator must open the ProPR Web UI, go to **Settings → Visual preview uploads**, '
    + 'and add or replace the personal access token. The token must have access to this repository. GitHub '
    + 'rejects GitHub App user (`ghu_`) and installation (`ghs_`) tokens for attachments. A server operator can '
    + 'alternatively set `GITHUB_VISUAL_PREVIEW_TOKEN`; that environment override takes precedence over the Web '
    + 'UI credential. Then request the visual preview again.',
  );
}

export function renderVisualPreviewSection(
  evidence: VisualPreviewEvidence,
  options: RenderVisualPreviewOptions,
): string {
  const published = options.published?.[publishedMetadataBrand] === true ? options.published.assets : [];
  const localAssets = options.useLocalPaths ? evidence.assets : [];
  if (localAssets.length === 0 && published.length === 0 && evidence.toolSuggestions.length === 0) return '';
  const parts = [VISUAL_PREVIEW_MARKER, '## Visual preview'];

  for (const asset of localAssets) appendLocalAsset(parts, asset);
  for (const item of published) appendPublishedAsset(parts, evidence, item);
  if (published.some(item => item.unavailableReason === 'github-authentication-failed')) {
    appendRestorePreviewUploadsGuidance(parts);
  }
  appendToolSuggestions(parts, evidence);
  return parts.join('\n\n');
}

export interface RenderVisualPreviewUploadFailureOptions { authenticationFailure?: boolean; }

export function renderVisualPreviewUploadFailureSection(
  evidence: VisualPreviewEvidence,
  options: RenderVisualPreviewUploadFailureOptions = {},
): string {
  const parts = [
    VISUAL_PREVIEW_MARKER,
    '## Visual preview',
    'Preview media was generated but could not be uploaded to GitHub. No preview files were committed.',
  ];
  if (options.authenticationFailure) {
    appendRestorePreviewUploadsGuidance(parts);
  }
  appendToolSuggestions(parts, evidence);
  return parts.join('\n\n');
}

export function appendVisualPreviewSection(body: string, section: string): string {
  if (!section) return body.replace(VISUAL_PREVIEW_SLOT, '');
  if (body.includes(VISUAL_PREVIEW_SLOT)) return body.replace(VISUAL_PREVIEW_SLOT, section);
  return `${body.trim()}\n\n---\n\n${section}`;
}
