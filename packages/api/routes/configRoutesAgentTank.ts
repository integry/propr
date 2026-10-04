import { Request, Response } from 'express';
import * as configManager from '@propr/core';
import {
  canRunBundledAgentTank,
  getAgentTankStatuses,
  hasAgentTankStatuses,
  hasUsableAgentTankStatuses,
  refreshBundledStatuses
} from '@propr/core';
import { AGENT_TANK_MODES, isAgentTankMode, normalizeAgentTankMode } from '@propr/shared';

/**
 * Tells every open tab that capacity may have moved.
 *
 * The event is a trigger, not a snapshot: each client re-reads
 * `/api/config/agent-tank/usage`, which keeps owning the projection and its
 * permission check. It goes out over Redis so a tab connected to another API
 * instance hears about the change too, and a failed publish only costs those
 * tabs freshness - it must never fail the request that caused it.
 */
function publishUsageChanged(): void {
  try {
    void configManager.getEventPublisher().publishUsageUpdate();
  } catch {
    // Freshness only; the write that caused this already succeeded.
  }
}

export function createAgentTankRoutes() {
  async function getAgentTankSettings(_req: Request, res: Response): Promise<void> {
    try {
      const settings = await configManager.loadAgentTankSettings();
      res.json(settings);
    } catch (error) {
      console.error('Error in /api/config/agent-tank GET:', error);
      res.status(500).json({ error: 'Failed to load Agent Tank settings' });
    }
  }

  async function postAgentTankSettings(req: Request, res: Response): Promise<void> {
    try {
      const { mode, enabled, url } = req.body ?? {};
      // Accept the legacy `{ enabled }` body so older CLI builds and any
      // in-flight clients keep working during a rolling upgrade.
      if (mode !== undefined && !isAgentTankMode(mode)) {
        res.status(400).json({ error: `mode must be one of: ${AGENT_TANK_MODES.join(', ')}` });
        return;
      }
      const resolvedMode = mode === undefined
        ? (enabled === true ? 'external' : 'disabled')
        : normalizeAgentTankMode(mode);
      if (resolvedMode === 'external' && typeof url === 'string' && url.trim() === '') {
        res.status(400).json({ error: 'url is required when mode is "external"' });
        return;
      }
      // Keep a hand-tuned external URL when the caller omits one (bundled mode
      // has no URL to send), so switching modes back and forth is lossless.
      const resolvedUrl = typeof url === 'string' && url.trim()
        ? url.trim()
        : (await configManager.loadAgentTankSettings()).url;
      await configManager.saveAgentTankSettings({ mode: resolvedMode, url: resolvedUrl });
      res.json({ success: true });
      // Enabling, disabling or repointing the integration changes what every
      // open sidebar should be showing, and the sidebar no longer polls to
      // find that out for itself.
      publishUsageChanged();
    } catch (error) {
      console.error('Error in /api/config/agent-tank POST:', error);
      res.status(500).json({ error: 'Failed to save Agent Tank settings' });
    }
  }

  async function getAgentTankStatus(_req: Request, res: Response): Promise<void> {
    try {
      const settings = await configManager.loadAgentTankSettings();
      if (settings.mode === 'disabled') {
        res.json({ available: false, reason: 'disabled' });
        return;
      }
      if (settings.mode === 'bundled') {
        // "Available" for bundled mode means "we can produce a snapshot that
        // carries at least one provider's usage", which is exactly what a
        // (cached) refresh answers. Reusing the same call keeps the status
        // indicator honest instead of asserting health from image presence alone.
        const agents = await refreshBundledStatuses();
        if (!agents) {
          res.json({ available: false, mode: 'bundled', reason: 'bundled_run_failed' });
          return;
        }
        // A run that had nothing to inspect - only OpenCode/Vibe enabled, or no
        // enabled agent at all - succeeds with an empty map and starts no
        // container. That is a successful run, not usage tracking: announcing it
        // as ready would promise a gauge that can never show a number.
        if (!hasAgentTankStatuses(agents)) {
          res.json({ available: false, mode: 'bundled', reason: 'no_supported_agents' });
          return;
        }
        // A provider Agent Tank failed to read still appears in the map, carrying
        // its error and an empty usage object. Keys alone therefore prove only
        // that a provider was configured, so readiness asks for usage that
        // actually came back.
        if (!hasUsableAgentTankStatuses(agents)) {
          res.json({ available: false, mode: 'bundled', reason: 'no_usage_data' });
          return;
        }
        res.json({ available: true, mode: 'bundled' });
        return;
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      try {
        const response = await fetch(`${settings.url}/status/claude`, { signal: controller.signal });
        clearTimeout(timer);
        if (response.ok) {
          res.json({ available: true, mode: 'external' });
        } else {
          res.json({ available: false, mode: 'external', reason: `HTTP ${response.status}` });
        }
      } catch {
        clearTimeout(timer);
        res.json({ available: false, mode: 'external', reason: 'unreachable' });
      }
    } catch (error) {
      console.error('Error in /api/config/agent-tank/status GET:', error);
      res.status(500).json({ error: 'Failed to check Agent Tank status' });
    }
  }

  async function getAgentTankUsage(_req: Request, res: Response): Promise<void> {
    try {
      const settings = await configManager.loadAgentTankSettings();
      if (settings.mode === 'disabled') {
        res.json({ enabled: false });
        return;
      }
      // One transport-agnostic call: the UI response shape is unchanged, so
      // AgentTankSidebar needs no modification for bundled mode.
      const agents = await getAgentTankStatuses();
      if (agents) {
        // Observe the exact normalized snapshot before returning it, for either transport.
        await configManager.observeAgentTankUsageSnapshot(agents);
      }
      res.json(agents
        ? { enabled: true, mode: settings.mode, agents }
        : {
          enabled: true,
          mode: settings.mode,
          error: settings.mode === 'bundled' ? 'bundled_run_failed' : 'unreachable'
        });
    } catch (error) {
      console.error('Error in /api/config/agent-tank/usage GET:', error);
      res.status(500).json({ error: 'Failed to fetch Agent Tank usage' });
    }
  }

  async function postAgentTankRefresh(_req: Request, res: Response): Promise<void> {
    try {
      const settings = await configManager.loadAgentTankSettings();
      if (settings.mode === 'disabled') {
        res.json({ success: false, error: 'Agent Tank not enabled' });
        return;
      }
      if (settings.mode === 'bundled') {
        // `force` because this is an explicit operator action: they pressed
        // refresh precisely because they do not trust the cached snapshot.
        const agents = await refreshBundledStatuses({ force: true });
        // Same evidence rule as the status route: a snapshot with no usable
        // provider usage - no provider at all, or only failed ones - did not
        // refresh any usage data, so it cannot be reported as a successful
        // refresh.
        if (!agents) {
          res.json({ success: false, error: 'bundled_run_failed' });
          return;
        }
        if (!hasAgentTankStatuses(agents)) {
          res.json({ success: false, error: 'no_supported_agents' });
          return;
        }
        const refreshed = hasUsableAgentTankStatuses(agents);
        res.json(refreshed
          ? { success: true }
          : { success: false, error: 'no_usage_data' });
        if (refreshed) publishUsageChanged();
        return;
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      try {
        const response = await fetch(`${settings.url}/refresh`, {
          method: 'POST',
          signal: controller.signal
        });
        clearTimeout(timer);
        if (response.ok) {
          res.json({ success: true });
          // A successful re-probe is the moment the numbers actually moved.
          publishUsageChanged();
        } else {
          res.json({ success: false, error: `HTTP ${response.status}` });
        }
      } catch {
        clearTimeout(timer);
        res.json({ success: false, error: 'unreachable' });
      }
    } catch (error) {
      console.error('Error in /api/config/agent-tank/refresh POST:', error);
      res.status(500).json({ error: 'Failed to refresh Agent Tank' });
    }
  }

  async function getAgentTankDetect(_req: Request, res: Response): Promise<void> {
    const DEFAULT_URL = 'http://host.docker.internal:3456';
    try {
      const settings = await configManager.loadAgentTankSettings();
      // Only offer the banner when tracking is entirely off.
      if (settings.mode !== 'disabled') {
        res.json({ detected: false, reason: 'already_enabled' });
        return;
      }
      // An external instance, if one happens to be running, wins the offer so
      // we point the operator at what they already set up. Otherwise bundled is
      // suggested: it is the lower-friction option and needs nothing installed.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);
      try {
        const response = await fetch(`${DEFAULT_URL}/status`, { signal: controller.signal });
        clearTimeout(timer);
        if (response.ok) {
          const data = await response.json();
          // Check if we got valid agent data
          const hasAgents = data && typeof data === 'object' && Object.keys(data).length > 0;
          if (hasAgents) {
            res.json({ detected: true, mode: 'external', url: DEFAULT_URL });
            return;
          }
        }
      } catch {
        clearTimeout(timer);
      }
      // Only offer bundled when it would actually report something: a fresh
      // install with no authenticated agent would just get an empty sidebar.
      const bundledUsable = await canRunBundledAgentTank();
      res.json(bundledUsable ? { detected: true, mode: 'bundled' } : { detected: false });
    } catch (error) {
      console.error('Error in /api/config/agent-tank/detect GET:', error);
      res.json({ detected: false });
    }
  }

  return {
    getAgentTankSettings,
    postAgentTankSettings,
    getAgentTankStatus,
    getAgentTankUsage,
    postAgentTankRefresh,
    getAgentTankDetect
  };
}
