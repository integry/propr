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
      res.json({
        ...await service.getStatus(),
        currentUsername: req.user?.username,
        canUseCurrentLogin: Boolean(
          req.user?.accessToken && isSupportedVisualPreviewUploadToken(req.user.accessToken),
        ),
      });
    } catch (error) {
      sendFailure(error, res);
    }
  }

  async function useCurrentLogin(req: Request, res: Response): Promise<void> {
    const credential = req.user ? visualPreviewCredentialFromUser(req.user) : null;
    if (!credential) {
      res.status(409).json({
        error: 'The current GitHub login did not provide an OAuth token supported by GitHub media uploads. Log out and sign in again.',
        code: 'VISUAL_PREVIEW_LOGIN_TOKEN_UNSUPPORTED',
      });
      return;
    }
    try {
      await service.replace(credential);
      res.json({
        ...await service.getStatus(),
        currentUsername: req.user?.username,
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
