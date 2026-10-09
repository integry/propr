import { area } from '../lib/world';

export const agentTank = (mode: 'disabled' | 'bundled' | 'external') => area('agent-tank', {
  '/api/config/agent-tank': { mode, enabled: mode !== 'disabled', url: 'http://host.docker.internal:3456' },
  '/api/config/agent-tank/status': { mode, available: true },
  '/api/config/agent-tank/detect': { detected: false },
});
