import { area } from '../lib/world';

/**
 * Agent Tank capacity for Northwind's subscriptions: how much of each plan
 * window is used. Capacity only — no spend.
 */
export const agentTankUsage = area('agent-tank-usage', {
  '/api/config/agent-tank/usage': {
    enabled: true,
    agents: {
      claude: { name: 'claude', usage: {
        session: { percent: 38, resetsIn: '2h 10m' },
        weeklyAll: { percent: 64, resetsIn: '3d 4h' },
        weeklySonnet: { percent: 21, resetsIn: '3d 4h' },
      } },
      codex: { name: 'codex', usage: { fiveHour: { percentUsed: 17, resetsIn: '1h 05m' }, weekly: { percentUsed: 82, resetsIn: '1d 9h' } } },
      antigravity: { name: 'antigravity', usage: { models: [
        { model: 'Gemini 3.1 Pro', percentUsed: 45, resetsIn: '3h 40m' },
        { model: 'Gemini Flash', percentUsed: 12, resetsIn: '3h 40m' },
      ] } },
    },
  },
  '/api/config/agent-tank/status': { mode: 'bundled', available: true },
  '/api/config/agent-tank': { mode: 'bundled', enabled: true, url: 'http://host.docker.internal:3456' },
});
