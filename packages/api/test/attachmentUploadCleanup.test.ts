import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { Response } from 'express';
import type { FlatRequest } from '../requestTypes.js';
import { createUploadAttachmentHandler } from '../routes/plannerHelpers/handlers/attachmentHandlers.js';
import { AttachmentService, closeConnection, type MulterFile } from '@propr/core';

const DRAFT_ID = '7394af2d-aa90-4c3c-aa1d-12cbbb477a63';

after(async () => closeConnection());

function uploadedFile(filePath: string): MulterFile {
  return {
    fieldname: 'file',
    originalname: 'notes.txt',
    encoding: '7bit',
    mimetype: 'text/plain',
    size: 5,
    destination: join(filePath, '..'),
    filename: 'upload',
    path: filePath,
  };
}

function responseRecorder(): { response: Response; status: () => number | undefined } {
  let statusCode: number | undefined;
  const response = {
    status(code: number) { statusCode = code; return this; },
    json() { return this; },
  } as unknown as Response;
  return { response, status: () => statusCode };
}

test('upload handler removes Multer files rejected before attachment processing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'propr-upload-cleanup-'));
  try {
    for (const [draftId, authorized, expectedStatus] of [
      ['invalid', true, 400],
      [DRAFT_ID, false, 403],
    ] as const) {
      const tempPath = join(root, `upload-${expectedStatus}`);
      writeFileSync(tempPath, 'notes');
      const req = {
        params: { id: draftId },
        user: { id: 'user-1' },
        file: uploadedFile(tempPath),
      } as unknown as FlatRequest;
      const recorder = responseRecorder();
      const handler = createUploadAttachmentHandler({
        tempRoot: root,
        verifyOwnership: async () => authorized
          ? { authorized: true }
          : { authorized: false, status: 403, error: 'Forbidden' },
      });

      await handler(req, recorder.response);

      assert.equal(recorder.status(), expectedStatus);
      assert.equal(existsSync(tempPath), false);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('attachment processing removes temporary and final files when persistence fails', async () => {
  const root = mkdtempSync(join(tmpdir(), 'propr-upload-cleanup-'));
  const tempPath = join(root, 'upload');
  const storageRoot = join(root, 'storage');
  writeFileSync(tempPath, 'notes');
  try {
    await assert.rejects(
      AttachmentService.processUpload(uploadedFile(tempPath), DRAFT_ID, {
        storageRoot,
        tempRoot: root,
        persistAttachment: async () => { throw new Error('database write failed'); },
      }),
      /database write failed/,
    );

    assert.equal(existsSync(tempPath), false);
    const draftDir = join(storageRoot, DRAFT_ID);
    assert.deepEqual(existsSync(draftDir) ? readdirSync(draftDir) : [], []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('temporary cleanup refuses paths outside its configured root', async () => {
  const root = mkdtempSync(join(tmpdir(), 'propr-upload-root-'));
  const outsideRoot = mkdtempSync(join(tmpdir(), 'propr-upload-outside-'));
  const outsidePath = join(outsideRoot, 'upload');
  writeFileSync(outsidePath, 'notes');
  try {
    await assert.rejects(
      AttachmentService.removeTemporaryUpload(outsidePath, root),
      /outside the configured upload directory/,
    );
    assert.equal(existsSync(outsidePath), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outsideRoot, { recursive: true, force: true });
  }
});

test('attachment processing rejects path-like draft IDs and still cleans its temp file', async () => {
  const root = mkdtempSync(join(tmpdir(), 'propr-upload-cleanup-'));
  const tempPath = join(root, 'upload');
  writeFileSync(tempPath, 'notes');
  try {
    await assert.rejects(
      AttachmentService.processUpload(uploadedFile(tempPath), '../../escape', {
        storageRoot: join(root, 'storage'),
        tempRoot: root,
        persistAttachment: async () => undefined,
      }),
      /valid UUID/,
    );
    assert.equal(existsSync(tempPath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
