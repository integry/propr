import type { Request, Response } from 'express';
import {
  parseVoiceBriefingScope,
  voiceBriefingResponseSchema,
  voiceCapabilitiesResponseSchema,
  type VoiceBriefingResponse,
  type VoiceBriefingScope,
} from '@propr/shared';

export interface VoiceBriefingReader {
  getBriefing(userId: string, scope?: VoiceBriefingScope): Promise<VoiceBriefingResponse>;
}

export interface VoiceRouteDependencies {
  briefingService: VoiceBriefingReader;
  logError?: (message: string) => void;
}

const capabilities = voiceCapabilitiesResponseSchema.parse({
  mode: 'on_demand',
  serverAudio: false,
  persistentSession: false,
  rawAudioAccepted: false,
  transcriptStored: false,
});

function authenticatedUserId(req: Request, res: Response): string | null {
  if (typeof req.user?.id !== 'string' || req.user.id.trim().length === 0) {
    res.status(401).json({ error: 'Authentication required' });
    return null;
  }
  return req.user.id;
}

function requestedScope(req: Request, res: Response): VoiceBriefingScope | null {
  try {
    return parseVoiceBriefingScope(req.query.scope);
  } catch {
    res.status(400).json({ error: 'Invalid voice briefing scope' });
    return null;
  }
}

export function createVoiceRoutes(dependencies: VoiceRouteDependencies) {
  const logError = dependencies.logError ?? console.error;

  function getCapabilities(req: Request, res: Response): void {
    if (!authenticatedUserId(req, res)) return;
    res.json(capabilities);
  }

  async function getBriefing(req: Request, res: Response): Promise<void> {
    const userId = authenticatedUserId(req, res);
    if (!userId) return;

    const scope = requestedScope(req, res);
    if (!scope) return;

    try {
      const briefing = await dependencies.briefingService.getBriefing(userId, scope);
      res.json(voiceBriefingResponseSchema.parse(briefing));
    } catch {
      // Provider and validation failures can contain private task data. Log only
      // the operation name and keep the response fixed at this boundary.
      logError('Failed to build voice briefing');
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  return { getCapabilities, getBriefing };
}
