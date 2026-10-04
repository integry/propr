import { Octokit } from '@octokit/core';
import type { Request, Response } from 'express';
import {
  handleGitHubRepositoryAccessError,
  resolveGitHubMetadataToken,
} from '../githubMetadataAuth.js';
import {
  loadPublishedPreview,
  PreviewMediaError,
  type PreviewAssociation,
} from '../services/previewMediaFetch.js';
import { previewMediaReader } from '../services/previewMediaProjection.js';

interface PreviewMediaDependencies {
  reader?: Pick<typeof previewMediaReader, 'enabledRepositories'>;
  resolveToken?: typeof resolveGitHubMetadataToken;
  createOctokit?: (token: string) => Pick<Octokit, 'request'>;
  fetch?: typeof fetch;
}

function parameter(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

function parseRequest(req: Request, kind: PreviewAssociation['kind']): {
  assetId: string;
  association: PreviewAssociation;
} | undefined {
  const owner = parameter(req.params.owner);
  const repo = parameter(req.params.repo);
  const assetId = parameter(req.params.assetId);
  const number = Number(parameter(req.params.number));
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)
    || ['.', '..'].includes(owner) || ['.', '..'].includes(repo)
    || !/^[A-Za-z0-9_-]+$/.test(assetId) || assetId.length > 128
    || !Number.isSafeInteger(number) || number < 1) return undefined;
  return { assetId, association: { kind, repository: `${owner}/${repo}`.toLowerCase(), number } };
}

export function createPreviewMediaRoutes(dependencies: PreviewMediaDependencies = {}) {
  const reader = dependencies.reader ?? previewMediaReader;
  const resolveToken = dependencies.resolveToken ?? resolveGitHubMetadataToken;
  const createOctokit = dependencies.createOctokit ?? (token => new Octokit({ auth: token, request: { timeout: 10_000 } }));
  const fetcher = dependencies.fetch ?? fetch;

  const serve = (kind: PreviewAssociation['kind']) => async (req: Request, res: Response): Promise<void> => {
    if (!req.user?.id) { res.status(401).json({ error: 'Authentication required' }); return; }
    const parsed = parseRequest(req, kind);
    if (!parsed) { res.status(400).json({ error: 'Invalid preview media identity' }); return; }
    try {
      // Same order as before the extraction: a repository without visual
      // previews answers 404 before any GitHub credential is resolved, so a
      // caller without a GitHub token never sees a credential error for it.
      const { repository } = parsed.association;
      const enabled = await reader.enabledRepositories([repository]);
      if (!enabled.has(repository)) { res.status(404).json({ error: 'Preview media not found' }); return; }
      const token = await resolveToken(req);
      const result = await loadPublishedPreview({
        ...parsed,
        token,
        octokit: createOctokit(token),
        fetch: fetcher,
        // The service re-checks enablement; reuse this request's read.
        reader: { enabledRepositories: async () => enabled },
      });
      res.set({
        'Cache-Control': 'private, no-store',
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'Content-Type': result.contentType,
        'Content-Length': String(result.body.byteLength),
        Vary: 'Authorization, Cookie',
        'X-Content-Type-Options': 'nosniff',
      });
      res.status(200).send(result.body);
    } catch (error) {
      // PreviewMediaError first: its 404s (asset not published, media gone)
      // were direct responses before the extraction and must not be rewritten
      // into the repository-access 404 by the status-based GitHub handler.
      if (error instanceof PreviewMediaError) { res.status(error.status).json({ error: error.message }); return; }
      if (await handleGitHubRepositoryAccessError(req, res, error)) return;
      res.status(502).json({ error: 'Preview media is temporarily unavailable' });
    }
  };

  return { getPullMedia: serve('pull'), getCommentMedia: serve('comment') };
}
