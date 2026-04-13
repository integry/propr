import { Request, Response } from 'express';
import * as configManager from '@propr/core';

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
      const { enabled, url } = req.body;
      await configManager.saveAgentTankSettings({ enabled: !!enabled, url: url || 'http://0.0.0.0:3456' });
      res.json({ success: true });
    } catch (error) {
      console.error('Error in /api/config/agent-tank POST:', error);
      res.status(500).json({ error: 'Failed to save Agent Tank settings' });
    }
  }

  async function getAgentTankStatus(_req: Request, res: Response): Promise<void> {
    try {
      const settings = await configManager.loadAgentTankSettings();
      if (!settings.enabled) {
        res.json({ available: false, reason: 'disabled' });
        return;
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      try {
        const response = await fetch(`${settings.url}/status/claude`, { signal: controller.signal });
        clearTimeout(timer);
        if (response.ok) {
          res.json({ available: true });
        } else {
          res.json({ available: false, reason: `HTTP ${response.status}` });
        }
      } catch {
        clearTimeout(timer);
        res.json({ available: false, reason: 'unreachable' });
      }
    } catch (error) {
      console.error('Error in /api/config/agent-tank/status GET:', error);
      res.status(500).json({ error: 'Failed to check Agent Tank status' });
    }
  }

  async function getAgentTankUsage(_req: Request, res: Response): Promise<void> {
    try {
      const settings = await configManager.loadAgentTankSettings();
      if (!settings.enabled) {
        res.json({ enabled: false });
        return;
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      try {
        const response = await fetch(`${settings.url}/status`, { signal: controller.signal });
        clearTimeout(timer);
        if (response.ok) {
          const data = await response.json();
          res.json({ enabled: true, agents: data });
        } else {
          res.json({ enabled: true, error: `HTTP ${response.status}` });
        }
      } catch {
        clearTimeout(timer);
        res.json({ enabled: true, error: 'unreachable' });
      }
    } catch (error) {
      console.error('Error in /api/config/agent-tank/usage GET:', error);
      res.status(500).json({ error: 'Failed to fetch Agent Tank usage' });
    }
  }

  async function postAgentTankRefresh(_req: Request, res: Response): Promise<void> {
    try {
      const settings = await configManager.loadAgentTankSettings();
      if (!settings.enabled) {
        res.json({ success: false, error: 'Agent Tank not enabled' });
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

  return {
    getAgentTankSettings,
    postAgentTankSettings,
    getAgentTankStatus,
    getAgentTankUsage,
    postAgentTankRefresh
  };
}
