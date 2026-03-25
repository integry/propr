/**
 * Attachment-related HTTP handlers.
 */

import { Request, Response } from 'express';
import { AttachmentService } from '@propr/core';
import type { MulterFile } from '@propr/core';
import type { OwnershipResult } from '../types.js';
import { validateUUID } from '../../validation.js';

interface AttachmentContentDeps {
  verifyOwnership: (draftId: string, userId: string, fields: string[]) => Promise<OwnershipResult>;
}

export function createGetAttachmentContentHandler(deps: AttachmentContentDeps) {
  return async function getAttachmentContent(req: Request, res: Response): Promise<void> {
    // Validate draft ID
    const idValidation = validateUUID(req.params.id, 'Draft ID');
    if (!idValidation.valid) {
      res.status(400).json({ error: idValidation.error });
      return;
    }

    // Validate attachment ID
    const attachmentIdValidation = validateUUID(req.params.attachmentId, 'Attachment ID');
    if (!attachmentIdValidation.valid) {
      res.status(400).json({ error: attachmentIdValidation.error });
      return;
    }

    try {
      const ownership = await deps.verifyOwnership(req.params.id, req.user!.id, ['user_id', 'attachments']);
      if (!ownership.authorized) { res.status(ownership.status!).json({ error: ownership.error }); return; }

      let attachments: { id: string; storedPath: string; mimeType: string; originalName: string }[] = [];
      const rawAttachments = ownership.draft?.attachments;
      if (typeof rawAttachments === 'string') {
        try { attachments = JSON.parse(rawAttachments); } catch { attachments = []; }
      } else if (Array.isArray(rawAttachments)) {
        attachments = rawAttachments;
      }
      const attachment = attachments.find(a => a.id === req.params.attachmentId);
      if (!attachment) { res.status(404).json({ error: 'Attachment not found' }); return; }

      const content = await AttachmentService.getAttachmentContent(attachment.storedPath);
      res.setHeader('Content-Type', attachment.mimeType);
      res.setHeader('Content-Disposition', `inline; filename="${attachment.originalName}"`);
      res.send(content);
    } catch (error) {
      console.error('Get attachment content error:', error);
      res.status(500).json({ error: 'Failed to get attachment content' });
    }
  };
}

interface UploadAttachmentDeps {
  verifyOwnership: (draftId: string, userId: string, fields?: string[]) => Promise<OwnershipResult>;
}

export function createUploadAttachmentHandler(deps: UploadAttachmentDeps) {
  return async function uploadAttachment(req: Request, res: Response): Promise<void> {
    // Validate draft ID
    const idValidation = validateUUID(req.params.id, 'Draft ID');
    if (!idValidation.valid) {
      res.status(400).json({ error: idValidation.error });
      return;
    }

    if (!req.file) { res.status(400).json({ error: 'No file uploaded' }); return; }
    try {
      const ownership = await deps.verifyOwnership(req.params.id, req.user!.id);
      if (!ownership.authorized) { res.status(ownership.status!).json({ error: ownership.error }); return; }

      const attachment = await AttachmentService.processUpload(req.file as MulterFile, req.params.id);
      res.json(attachment);
    } catch (error) {
      console.error('Upload attachment error:', error);
      const message = error instanceof Error ? error.message : 'Processing failed';
      const status = message.includes('not supported') || message.includes('Unsupported') ? 400 : 500;
      res.status(status).json({ error: message });
    }
  };
}

interface DeleteAttachmentDeps {
  verifyOwnership: (draftId: string, userId: string, fields?: string[]) => Promise<OwnershipResult>;
}

export function createDeleteAttachmentHandler(deps: DeleteAttachmentDeps) {
  return async function deleteAttachment(req: Request, res: Response): Promise<void> {
    // Validate draft ID
    const idValidation = validateUUID(req.params.id, 'Draft ID');
    if (!idValidation.valid) {
      res.status(400).json({ error: idValidation.error });
      return;
    }

    // Validate attachment ID
    const attachmentIdValidation = validateUUID(req.params.attachmentId, 'Attachment ID');
    if (!attachmentIdValidation.valid) {
      res.status(400).json({ error: attachmentIdValidation.error });
      return;
    }

    try {
      const ownership = await deps.verifyOwnership(req.params.id, req.user!.id);
      if (!ownership.authorized) { res.status(ownership.status!).json({ error: ownership.error }); return; }

      await AttachmentService.deleteAttachment(req.params.id, req.params.attachmentId);
      res.status(204).send();
    } catch (error) {
      console.error('Delete attachment error:', error);
      const message = error instanceof Error ? error.message : 'Failed to delete attachment';
      res.status(message.includes('not found') ? 404 : 500).json({ error: message });
    }
  };
}
