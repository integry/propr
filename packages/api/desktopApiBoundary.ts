import type { Express, RequestHandler } from 'express';
import { ensureAuthenticated } from './auth.js';
import { resolveAuthorization } from './authorization.js';
import {
  createDiscoveryRequestRateLimiter,
  createPairingPollRateLimiter,
  createPairingStartRateLimiter,
} from './requestRateLimits.js';

export interface DesktopApiBoundaryRoutes {
  discovery: RequestHandler;
  startPairing: RequestHandler;
  pollPairing: RequestHandler;
  activatePairing: RequestHandler;
  cancelPairing: RequestHandler;
  openPairingApproval: RequestHandler;
  revokeCurrentToken: RequestHandler;
}

/**
 * Register the complete public desktop bootstrap boundary and then close it
 * with the generic API authentication/authorization guard. Operational routes
 * must be registered only after this function returns.
 */
export function registerDesktopApiBoundary(
  app: Express,
  routes: DesktopApiBoundaryRoutes,
): void {
  app.get('/api/desktop/discovery', createDiscoveryRequestRateLimiter(), routes.discovery);
  app.post('/api/desktop/pairings', createPairingStartRateLimiter(), routes.startPairing);
  app.post('/api/desktop/pairings/:pairingId/poll', createPairingPollRateLimiter(), routes.pollPairing);
  app.post('/api/desktop/pairings/:pairingId/activate', createPairingPollRateLimiter(), routes.activatePairing);
  app.post('/api/desktop/pairings/:pairingId/cancel', createPairingPollRateLimiter(), routes.cancelPairing);
  app.get('/api/desktop/pairings/:pairingId/browser', createPairingStartRateLimiter(), routes.openPairingApproval);
  // Token possession authorizes only this exact self-revocation route. It must
  // precede generic auth so inactive tokens receive a stable terminal contract.
  app.delete('/api/desktop/tokens/current', routes.revokeCurrentToken);
  app.use('/api', ensureAuthenticated, resolveAuthorization);
}
