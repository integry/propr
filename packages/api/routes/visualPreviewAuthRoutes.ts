import type { Request, Response } from 'express';
import {
  VisualPreviewOAuthCredentialService,
  isSupportedVisualPreviewUploadToken,
} from '@propr/core';
import {
  visualPreviewCredentialFromUser,
  visualPreviewOAuthCredentialService,
} from '../services/visualPreviewOAuth.js';

interface VisualPreviewAuthRoutesDeps {
  service?: VisualPreviewOAuthCredentialService;
}

type CurrentLoginTokenType = 'supported' | 'github_app_user' | 'unsupported' | 'missing';

function currentLoginTokenType(accessToken?: string): CurrentLoginTokenType {
  const token = accessToken?.trim();
  if (!token) return 'missing';
  if (isSupportedVisualPreviewUploadToken(token)) return 'supported';
  if (token.startsWith('ghu_')) return 'github_app_user';
  return 'unsupported';
}

function sendFailure(error: unknown, res: Response): void {
  console.error('[visual-preview] Credential administration failed:', error);
  res.status(500).json({
    error: 'Visual-preview upload credential administration failed',
    code: 'VISUAL_PREVIEW_AUTH_ADMINISTRATION_FAILED',
  });
}

export function createVisualPreviewAuthRoutes({
  service = visualPreviewOAuthCredentialService,
}: VisualPreviewAuthRoutesDeps = {}) {
  async function getStatus(req: Request, res: Response): Promise<void> {
    try {
      const loginTokenType = currentLoginTokenType(req.user?.accessToken);
      res.json({
        ...await service.getStatus(),
        currentUsername: req.user?.username,
        currentLoginTokenType: loginTokenType,
        canUseCurrentLogin: loginTokenType === 'supported',
      });
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
          ? 'The current login uses a GitHub App user token, which GitHub attachment uploads reject. Configure Web UI login with a GitHub OAuth App or use GITHUB_VISUAL_PREVIEW_TOKEN with an OAuth App token or PAT.'
          : 'The current GitHub login did not provide an OAuth App token or personal access token supported by GitHub attachment uploads.',
        code: 'VISUAL_PREVIEW_LOGIN_TOKEN_UNSUPPORTED',
      });
      return;
    }
    try {
      await service.replace(credential);
      res.json({
        ...await service.getStatus(),
        currentUsername: req.user?.username,
        currentLoginTokenType: 'supported',
        canUseCurrentLogin: true,
      });
    } catch (error) {
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

  return { getStatus, useCurrentLogin, disconnect };
}
