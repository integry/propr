import type { Request, Response } from 'express';
import {
  VisualPreviewOAuthCredentialService,
  isSupportedVisualPreviewUploadToken,
  type VisualPreviewOAuthCredentialStatus,
} from '@propr/core';
import {
  visualPreviewCredentialFromUser,
  visualPreviewOAuthCredentialService,
} from '../services/visualPreviewOAuth.js';

const GITHUB_USER_URL = 'https://api.github.com/user';
const GITHUB_REQUEST_TIMEOUT_MS = 20_000;
const MAX_TOKEN_LENGTH = 512;

interface VisualPreviewAuthRoutesDeps {
  service?: VisualPreviewOAuthCredentialService;
  fetchImpl?: typeof fetch;
}

type CurrentLoginTokenType = 'supported' | 'github_app_user' | 'unsupported' | 'missing';

function currentLoginTokenType(accessToken?: string): CurrentLoginTokenType {
  const token = accessToken?.trim();
  if (!token) return 'missing';
  if (isSupportedVisualPreviewUploadToken(token)) return 'supported';
  if (token.startsWith('ghu_')) return 'github_app_user';
  return 'unsupported';
}

function statusResponse(req: Request, status: VisualPreviewOAuthCredentialStatus) {
  const loginTokenType = currentLoginTokenType(req.user?.accessToken);
  return {
    ...status,
    currentUsername: req.user?.username,
    currentLoginTokenType: loginTokenType,
    canUseCurrentLogin: loginTokenType === 'supported',
  };
}

function sendFailure(error: unknown, res: Response): void {
  console.error('[visual-preview] Credential administration failed:', error);
  res.status(500).json({
    error: 'Visual-preview upload credential administration failed',
    code: 'VISUAL_PREVIEW_AUTH_ADMINISTRATION_FAILED',
  });
}

function readSubmittedToken(req: Request): string | null {
  const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
  if (!token || token.length > MAX_TOKEN_LENGTH || !isSupportedVisualPreviewUploadToken(token)) return null;
  return token;
}

async function fetchGitHubIdentity(token: string, fetchImpl: typeof fetch): Promise<{
  status: number;
  id?: string;
  username?: string;
}> {
  const response = await fetchImpl(GITHUB_USER_URL, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'user-agent': 'ProPR',
      'x-github-api-version': '2022-11-28',
    },
    signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) return { status: response.status };
  const identity = await response.json() as { id?: number; login?: string };
  if (!Number.isSafeInteger(identity.id) || !identity.login) return { status: 502 };
  return { status: 200, id: String(identity.id), username: identity.login };
}

export function createVisualPreviewAuthRoutes({
  service = visualPreviewOAuthCredentialService,
  fetchImpl = fetch,
}: VisualPreviewAuthRoutesDeps = {}) {
  async function getStatus(req: Request, res: Response): Promise<void> {
    try {
      res.json(statusResponse(req, await service.getStatus()));
    } catch (error) {
      sendFailure(error, res);
    }
  }

  async function useCurrentLogin(req: Request, res: Response): Promise<void> {
    const credential = req.user ? visualPreviewCredentialFromUser(req.user) : null;
    if (!credential) {
      const githubAppUserToken = currentLoginTokenType(req.user?.accessToken) === 'github_app_user';
      res.status(409).json({
        error: githubAppUserToken
          ? 'The current login uses a GitHub App user token, which GitHub attachment uploads reject. Add a personal access token in Visual preview uploads instead.'
          : 'The current GitHub login did not provide an OAuth App token or personal access token supported by GitHub attachment uploads.',
        code: 'VISUAL_PREVIEW_LOGIN_TOKEN_UNSUPPORTED',
      });
      return;
    }
    try {
      await service.replace(credential);
      res.json(statusResponse(req, await service.getStatus()));
    } catch (error) {
      sendFailure(error, res);
    }
  }

  async function usePersonalAccessToken(req: Request, res: Response): Promise<void> {
    const token = readSubmittedToken(req);
    if (!token) {
      res.status(400).json({
        error: 'Enter a GitHub OAuth App token or personal access token (gho_, ghp_, or github_pat_). GitHub App tokens are not supported for attachment uploads.',
        code: 'VISUAL_PREVIEW_TOKEN_UNSUPPORTED',
      });
      return;
    }

    try {
      const currentStatus = await service.getStatus();
      if (currentStatus.source === 'environment') {
        res.status(409).json({
          error: 'GITHUB_VISUAL_PREVIEW_TOKEN manages this credential. Remove the environment override and restart the stack before saving a token in Settings.',
          code: 'VISUAL_PREVIEW_TOKEN_ENVIRONMENT_MANAGED',
        });
        return;
      }

      const identity = await fetchGitHubIdentity(token, fetchImpl);
      if (identity.status === 401 || identity.status === 403) {
        res.status(400).json({
          error: 'GitHub rejected this token. Check that it is active and has access to the repositories where previews are uploaded.',
          code: 'VISUAL_PREVIEW_TOKEN_INVALID',
        });
        return;
      }
      if (identity.status !== 200 || !identity.id || !identity.username) {
        res.status(502).json({
          error: 'GitHub could not validate this token. Please try again.',
          code: 'VISUAL_PREVIEW_TOKEN_VALIDATION_FAILED',
        });
        return;
      }

      await service.replace({
        githubUserId: identity.id,
        githubUsername: identity.username,
        source: 'static_token',
        accessToken: token,
      });
      res.json(statusResponse(req, await service.getStatus()));
    } catch (error) {
      if (error instanceof TypeError || (error instanceof Error && error.name === 'TimeoutError')) {
        res.status(502).json({
          error: 'GitHub could not validate this token. Please try again.',
          code: 'VISUAL_PREVIEW_TOKEN_VALIDATION_FAILED',
        });
        return;
      }
      sendFailure(error, res);
    }
  }

  async function disconnect(_req: Request, res: Response): Promise<void> {
    try {
      await service.disconnect();
      res.status(204).end();
    } catch (error) {
      sendFailure(error, res);
    }
  }

  return { getStatus, useCurrentLogin, usePersonalAccessToken, disconnect };
}
