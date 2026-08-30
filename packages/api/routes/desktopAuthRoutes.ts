import type { Request, RequestHandler, Response } from 'express';
import {
  DesktopAuthError,
  DesktopAuthService,
  desktopAuthService,
} from '../desktopAuthService.js';
import { isUserWhitelisted } from '../userWhitelist.js';
import {
  DESKTOP_REVOCATION_BINDING_HEADER,
  DESKTOP_TOKEN_REVOCATION_ENDPOINT,
  DESKTOP_TOKEN_REVOCATION_SCHEMA,
  DESKTOP_TOKEN_REVOCATION_VERSION,
  canonicalProprHttpUrlOrigin,
  normalizeProprApiOrigin,
} from '@propr/shared';

interface DesktopAuthRoutesOptions {
  service?: DesktopAuthService;
  frontendUrl?: string;
}

function pathParameter(value: string | string[]): string {
  return Array.isArray(value) ? value[0] ?? '' : value;
}

function sendDesktopAuthError(error: unknown, res: Response): void {
  if (error instanceof DesktopAuthError) {
    res.status(error.status).json({ code: error.code, error: error.message });
    return;
  }
  console.error('[desktop-auth] Request failed:', error);
  res.status(500).json({ code: 'DESKTOP_AUTH_FAILED', error: 'Desktop authentication request failed' });
}

export function isTrustedPairingApprovalOrigin(origin: string | undefined, frontendUrl: string | undefined): boolean {
  if (!origin || !frontendUrl) return false;
  const expected = canonicalProprHttpUrlOrigin(frontendUrl);
  const supplied = normalizeProprApiOrigin(origin);
  return expected !== null && supplied === expected;
}

/** Pairing approval is intentionally session-only. */
export function requireBrowserPairingSession(): RequestHandler {
  return (req, res, next) => {
    if (req.authenticationMethod !== 'session' || !req.isAuthenticated?.() || !req.user) {
      res.status(403).json({
        code: 'BROWSER_SESSION_REQUIRED',
        error: 'Pairing approval requires an authenticated browser session',
      });
      return;
    }
    next();
  };
}

/** Mutating approval additionally requires the exact configured UI origin. */
export function requirePairingApprovalOrigin(frontendUrl = process.env.FRONTEND_URL): RequestHandler {
  return (req, res, next) => {
    if (!isTrustedPairingApprovalOrigin(req.header('origin'), frontendUrl)) {
      res.status(403).json({ code: 'UNTRUSTED_APPROVAL_ORIGIN', error: 'Pairing approval origin is not trusted' });
      return;
    }
    next();
  };
}

export function createDesktopAuthRoutes(options: DesktopAuthRoutesOptions = {}) {
  const service = options.service ?? desktopAuthService;
  const browserSessionGuard = requireBrowserPairingSession();
  const approvalOriginGuard = requirePairingApprovalOrigin(options.frontendUrl);

  async function startPairing(req: Request, res: Response): Promise<void> {
    try {
      const result = await service.startPairing((req.body as { clientName?: unknown } | undefined)?.clientName);
      res.status(201).json(result);
    } catch (error) {
      sendDesktopAuthError(error, res);
    }
  }

  async function pollPairing(req: Request, res: Response): Promise<void> {
    try {
      const result = await service.pollPairing(
        pathParameter(req.params.pairingId),
        (req.body as { deviceSecret?: unknown } | undefined)?.deviceSecret,
      );
      res.status(result.status === 'pending' ? 202 : 200).json(result);
    } catch (error) {
      sendDesktopAuthError(error, res);
    }
  }

  async function getPairingApproval(req: Request, res: Response): Promise<void> {
    try {
      res.json(await service.getPairingForApproval(pathParameter(req.params.pairingId)));
    } catch (error) {
      sendDesktopAuthError(error, res);
    }
  }

  async function openPairingApproval(req: Request, res: Response): Promise<void> {
    const pairingId = pathParameter(req.params.pairingId);
    try {
      await service.getPairingForApproval(pairingId);
      const frontendUrl = service.getFrontendApprovalUrl(pairingId).toString();
      if (req.isAuthenticated?.() && req.user && isUserWhitelisted(req.user.username)) {
        res.redirect(frontendUrl);
        return;
      }
      res.redirect(`/api/auth/github?redirect_to=${encodeURIComponent(frontendUrl)}`);
    } catch (error) {
      sendDesktopAuthError(error, res);
    }
  }

  async function approvePairing(req: Request, res: Response): Promise<void> {
    if (!req.user) {
      res.status(401).json({ code: 'AUTHENTICATION_REQUIRED', error: 'Authentication required' });
      return;
    }
    try {
      res.json(await service.approvePairing(pathParameter(req.params.pairingId), req.user));
    } catch (error) {
      sendDesktopAuthError(error, res);
    }
  }

  async function listTokens(req: Request, res: Response): Promise<void> {
    if (!req.user) {
      res.status(401).json({ code: 'AUTHENTICATION_REQUIRED', error: 'Authentication required' });
      return;
    }
    try {
      res.json({ tokens: await service.listTokens(req.user.id) });
    } catch (error) {
      sendDesktopAuthError(error, res);
    }
  }

  async function revokeToken(req: Request, res: Response): Promise<void> {
    if (!req.user) {
      res.status(401).json({ code: 'AUTHENTICATION_REQUIRED', error: 'Authentication required' });
      return;
    }
    try {
      await service.revokeToken(pathParameter(req.params.tokenId), req.user);
      res.status(204).end();
    } catch (error) {
      sendDesktopAuthError(error, res);
    }
  }

  async function revokeCurrentToken(req: Request, res: Response): Promise<void> {
    const authorization = req.header('authorization');
    const credentialGeneration = req.header(DESKTOP_REVOCATION_BINDING_HEADER);
    if (!authorization || !/^Bearer propr_it_[A-Za-z0-9_-]{43}$/.test(authorization)
      || !credentialGeneration
      || !/^[A-Za-z0-9_-]{22}$/.test(credentialGeneration)) {
      res.status(403).json({
        code: 'INSTANCE_TOKEN_REQUIRED',
        error: 'The current desktop token is required',
      });
      return;
    }
    try {
      const result = await service.revokePresentedToken(authorization.slice(7).trim());
      if (result.revoked) {
        res.status(204).end();
        return;
      }
      res.status(result.code === 'TOKEN_NOT_FOUND' ? 404 : 401).json({
        schema: DESKTOP_TOKEN_REVOCATION_SCHEMA,
        version: DESKTOP_TOKEN_REVOCATION_VERSION,
        endpoint: DESKTOP_TOKEN_REVOCATION_ENDPOINT,
        terminal: true,
        code: result.code,
        credentialGeneration,
      });
    } catch (error) {
      sendDesktopAuthError(error, res);
    }
  }

  return {
    browserSessionGuard,
    approvalOriginGuard,
    startPairing,
    pollPairing,
    getPairingApproval,
    openPairingApproval,
    approvePairing,
    listTokens,
    revokeCurrentToken,
    revokeToken,
  };
}
