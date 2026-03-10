import { Request, Response } from 'express';

interface RepoChatRequest {
  repository: string;
  prompt: string;
}

export function createRepoChatRoutes() {
  async function postChat(req: Request, res: Response): Promise<void> {
    try {
      const { repository, prompt } = req.body as RepoChatRequest;

      // Validate required fields
      if (!repository || typeof repository !== 'string') {
        res.status(400).json({ error: 'repository is required and must be a string' });
        return;
      }

      if (!prompt || typeof prompt !== 'string') {
        res.status(400).json({ error: 'prompt is required and must be a string' });
        return;
      }

      // Basic handler - extract and validate parameters
      // This serves as the entry point for LLM integration
      res.json({
        success: true,
        repository,
        prompt,
        message: 'Chat request received'
      });
    } catch (error) {
      console.error('Error in /api/repos/chat:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  return {
    postChat
  };
}
