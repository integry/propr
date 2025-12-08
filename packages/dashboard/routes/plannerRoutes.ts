import { Request, Response } from 'express';
import { Knex } from 'knex';
import multer from 'multer';
import path from 'path';
import fs from 'fs-extra';
import { AttachmentService } from '@gitfix/core';
import type { MulterFile } from '@gitfix/core';

const uploadDir = path.join(process.cwd(), 'temp_uploads');
fs.ensureDirSync(uploadDir);

const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 10 * 1024 * 1024 }
});

export const attachmentUpload = upload.single('file');

interface PlannerRoutesDeps {
  db: Knex | null;
  isDbEnabled: boolean;
}

export function createPlannerRoutes(deps: PlannerRoutesDeps) {
  const { db, isDbEnabled } = deps;

  async function listDrafts(req: Request, res: Response): Promise<void> {
    if (!isDbEnabled || !db) {
      res.status(503).json({ error: 'Database not available' });
      return;
    }

    try {
      const userId = req.user?.id;
      if (!userId) {
        res.status(401).json({ error: 'User not authenticated' });
        return;
      }

      const limit = Math.min(Number(req.query.limit) || 10, 100);

      const drafts = await db('task_drafts')
        .where({ user_id: userId })
        .select('draft_id', 'name', 'repository', 'status', 'updated_at', 'created_at')
        .orderBy('updated_at', 'desc')
        .limit(limit);

      res.json(drafts);
    } catch (error) {
      console.error('List drafts error:', error);
      res.status(500).json({ error: 'Failed to fetch drafts' });
    }
  }

  async function createDraft(req: Request, res: Response): Promise<void> {
    if (!isDbEnabled || !db) {
      res.status(503).json({ error: 'Database not available' });
      return;
    }

    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ error: 'User not authenticated' });
      return;
    }

    const { repository, prompt } = req.body;

    if (!repository) {
      res.status(400).json({ error: 'Repository is required' });
      return;
    }

    try {
      const name = prompt
        ? prompt.substring(0, 50) + (prompt.length > 50 ? '...' : '')
        : 'Untitled Plan';

      const [draft] = await db('task_drafts')
        .insert({
          user_id: userId,
          repository,
          initial_prompt: prompt,
          name
        })
        .returning('*');

      res.status(201).json(draft);
    } catch (error) {
      console.error('Create draft error:', error);
      res.status(500).json({ error: 'Failed to create draft' });
    }
  }

  async function getDraft(req: Request, res: Response): Promise<void> {
    if (!isDbEnabled || !db) {
      res.status(503).json({ error: 'Database not available' });
      return;
    }

    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ error: 'User not authenticated' });
      return;
    }

    try {
      const draft = await db('task_drafts')
        .where({ draft_id: req.params.id })
        .first();

      if (!draft) {
        res.status(404).json({ error: 'Draft not found' });
        return;
      }

      if (draft.user_id !== userId) {
        res.status(403).json({ error: 'Unauthorized access to draft' });
        return;
      }

      res.json(draft);
    } catch (error) {
      console.error('Get draft error:', error);
      res.status(500).json({ error: 'Failed to fetch draft' });
    }
  }

  async function updateDraft(req: Request, res: Response): Promise<void> {
    if (!isDbEnabled || !db) {
      res.status(503).json({ error: 'Database not available' });
      return;
    }

    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ error: 'User not authenticated' });
      return;
    }

    try {
      const existing = await db('task_drafts')
        .select('user_id')
        .where({ draft_id: req.params.id })
        .first();

      if (!existing) {
        res.status(404).json({ error: 'Draft not found' });
        return;
      }

      if (existing.user_id !== userId) {
        res.status(403).json({ error: 'Unauthorized' });
        return;
      }

      const { plan_json, context_config, status, name } = req.body;

      const updateData: Record<string, unknown> = {
        updated_at: db.fn.now()
      };

      if (plan_json !== undefined) {
        updateData.plan_json = JSON.stringify(plan_json);
      }
      if (context_config !== undefined) {
        updateData.context_config = JSON.stringify(context_config);
      }
      if (status !== undefined) {
        updateData.status = status;
      }
      if (name !== undefined) {
        updateData.name = name;
      }

      const [updated] = await db('task_drafts')
        .where({ draft_id: req.params.id })
        .update(updateData)
        .returning('*');

      res.json(updated);
    } catch (error) {
      console.error('Update draft error:', error);
      res.status(500).json({ error: 'Failed to update draft' });
    }
  }

  async function deleteDraft(req: Request, res: Response): Promise<void> {
    if (!isDbEnabled || !db) {
      res.status(503).json({ error: 'Database not available' });
      return;
    }

    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ error: 'User not authenticated' });
      return;
    }

    try {
      const existing = await db('task_drafts')
        .select('user_id')
        .where({ draft_id: req.params.id })
        .first();

      if (!existing) {
        res.status(404).json({ error: 'Draft not found' });
        return;
      }

      if (existing.user_id !== userId) {
        res.status(403).json({ error: 'Unauthorized' });
        return;
      }

      await db('task_drafts')
        .where({ draft_id: req.params.id })
        .delete();

      res.status(204).send();
    } catch (error) {
      console.error('Delete draft error:', error);
      res.status(500).json({ error: 'Failed to delete draft' });
    }
  }

  async function uploadAttachment(req: Request, res: Response): Promise<void> {
    if (!isDbEnabled || !db) {
      res.status(503).json({ error: 'Database not available' });
      return;
    }

    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ error: 'User not authenticated' });
      return;
    }

    if (!req.file) {
      res.status(400).json({ error: 'No file uploaded' });
      return;
    }

    try {
      const existing = await db('task_drafts')
        .select('user_id')
        .where({ draft_id: req.params.id })
        .first();

      if (!existing) {
        res.status(404).json({ error: 'Draft not found' });
        return;
      }

      if (existing.user_id !== userId) {
        res.status(403).json({ error: 'Unauthorized access to draft' });
        return;
      }

      const attachment = await AttachmentService.processUpload(
        req.file as MulterFile,
        req.params.id
      );

      res.json(attachment);
    } catch (error) {
      console.error('Upload attachment error:', error);
      const message = error instanceof Error ? error.message : 'Processing failed';
      if (message.includes('not supported') || message.includes('Unsupported')) {
        res.status(400).json({ error: message });
      } else {
        res.status(500).json({ error: message });
      }
    }
  }

  async function getContextStats(req: Request, res: Response): Promise<void> {
    if (!isDbEnabled || !db) {
      res.status(503).json({ error: 'Database not available' });
      return;
    }

    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ error: 'User not authenticated' });
      return;
    }

    const { draftId, level } = req.body;

    if (!draftId) {
      res.status(400).json({ error: 'draftId is required' });
      return;
    }

    try {
      const existing = await db('task_drafts')
        .select('user_id')
        .where({ draft_id: draftId })
        .first();

      if (!existing) {
        res.status(404).json({ error: 'Draft not found' });
        return;
      }

      if (existing.user_id !== userId) {
        res.status(403).json({ error: 'Unauthorized access to draft' });
        return;
      }

      // Token estimates based on context level
      const levelMultipliers: Record<string, number> = {
        low: 1,
        medium: 3,
        high: 10
      };
      const multiplier = levelMultipliers[level] || levelMultipliers.medium;

      // Base token estimate (structure only)
      const baseTokens = 5000;
      const tokenCount = baseTokens * multiplier;

      // Cost estimate: ~$3 per 1M input tokens for Claude
      const costEstimate = (tokenCount / 1_000_000) * 3;

      // Smart files based on level
      const smartFiles = level === 'low' ? 0 : level === 'medium' ? 15 : 50;

      res.json({
        tokenCount,
        costEstimate,
        smartFiles
      });
    } catch (error) {
      console.error('Get context stats error:', error);
      res.status(500).json({ error: 'Failed to get context stats' });
    }
  }

  async function deleteAttachment(req: Request, res: Response): Promise<void> {
    if (!isDbEnabled || !db) {
      res.status(503).json({ error: 'Database not available' });
      return;
    }

    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ error: 'User not authenticated' });
      return;
    }

    try {
      const existing = await db('task_drafts')
        .select('user_id')
        .where({ draft_id: req.params.id })
        .first();

      if (!existing) {
        res.status(404).json({ error: 'Draft not found' });
        return;
      }

      if (existing.user_id !== userId) {
        res.status(403).json({ error: 'Unauthorized' });
        return;
      }

      await AttachmentService.deleteAttachment(req.params.id, req.params.attachmentId);
      res.status(204).send();
    } catch (error) {
      console.error('Delete attachment error:', error);
      const message = error instanceof Error ? error.message : 'Failed to delete attachment';
      if (message.includes('not found')) {
        res.status(404).json({ error: message });
      } else {
        res.status(500).json({ error: message });
      }
    }
  }

  return {
    listDrafts,
    createDraft,
    getDraft,
    updateDraft,
    deleteDraft,
    uploadAttachment,
    deleteAttachment,
    getContextStats
  };
}
