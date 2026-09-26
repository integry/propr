import path from 'node:path';
import {
  createManagedPreviewStorageClient, issueQueue, logger,
  type ManagedPreviewUploadResult, type ManagedPreviewOriginalInput, type VisualPreviewEvidence,
} from '@propr/core';
import { ROUTING_STATUS_REDIS_KEY } from '@propr/shared';

const contentTypes: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.mp4': 'video/mp4',
  '.mov': 'video/quicktime', '.webm': 'video/webm',
};

export interface ManagedVisualPreviewContext {
  taskId: string;
  repository: string;
  pullRequestNumber?: number;
}

/** One result per input asset, in input order. Index also disambiguates duplicate paths. */
export type ManagedVisualPreviewAssetResult = {
  version: 1;
  assetIndex: number;
  relativePath: string;
} & ManagedPreviewUploadResult;

interface StorageDependencies {
  createClient?: () => { uploadOriginal(input: ManagedPreviewOriginalInput): Promise<ManagedPreviewUploadResult> };
}

/** Store independently of GitHub publication. Only finalized, trusted viewer metadata leaves this boundary. */
export async function storeManagedVisualPreviewOriginals(
  evidence: VisualPreviewEvidence,
  context: ManagedVisualPreviewContext,
  dependencies: StorageDependencies = {},
): Promise<ManagedVisualPreviewAssetResult[]> {
  const results: ManagedVisualPreviewAssetResult[] = [];
  let client: ReturnType<NonNullable<StorageDependencies['createClient']>>;
  try {
    client = dependencies.createClient?.()
      ?? createManagedPreviewStorageClient(async () => (await issueQueue.client).get(ROUTING_STATUS_REDIS_KEY));
  } catch {
    return evidence.assets.map((asset, assetIndex) => ({
      version: 1, assetIndex, relativePath: asset.relativePath, stored: false, code: 'unavailable',
    }));
  }
  for (const [assetIndex, asset] of evidence.assets.entries()) {
    let result: ManagedPreviewUploadResult;
    try {
      const contentType = contentTypes[path.extname(asset.absolutePath).toLowerCase()];
      result = contentType
        ? await client.uploadOriginal({
          filePath: asset.absolutePath, contentType, ...context,
          displayFilename: path.basename(asset.relativePath),
        })
        : { stored: false, code: 'content_type_not_allowed' };
    } catch {
      result = { stored: false, code: 'unavailable' };
    }
    if (!result.stored) logger.warn({ code: result.code }, 'Managed preview original was not stored; continuing GitHub publication');
    results.push({ version: 1, assetIndex, relativePath: asset.relativePath, ...result });
  }
  return results;
}
