import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { closeConnection } from '@propr/core';
import {
  appendGoalAttachments,
  GOAL_ATTACHMENT_SECTION_HEADING,
  parseGoalAttachments,
  publicGoalAttachments,
  stripGoalAttachmentSection,
} from '../services/goalAttachmentService.js';

const attachment = {
  id: 'attachment-1',
  originalName: 'reference.png',
  storedPath: '/tmp/git-processor/goal-attachments/goal-1/reference.webp',
  mimeType: 'image/webp',
  size: 128,
  tokenEstimate: 20,
  type: 'image' as const,
};

after(async () => closeConnection());

test('goal attachment prompts expose stable local paths without exposing storage paths in API metadata', () => {
  const prompt = appendGoalAttachments('Use the reference.', [attachment]);
  assert.match(prompt, /Use the reference\./);
  assert.match(prompt, /"reference\.png" \(image\/webp\)/);
  assert.match(prompt, /\/tmp\/git-processor\/goal-attachments\/goal-1\/reference\.webp/);
  assert.deepEqual(publicGoalAttachments([attachment]), [{
    id: 'attachment-1', originalName: 'reference.png', mimeType: 'image/webp',
    size: 128, tokenEstimate: 20, type: 'image',
  }]);
  assert.deepEqual(parseGoalAttachments(JSON.stringify([attachment])), [attachment]);
});

test('goal attachment prompt rejects paths outside goal attachment storage', () => {
  assert.throws(
    () => appendGoalAttachments('Unsafe.', [{ ...attachment, storedPath: '/tmp/unrelated/reference.webp' }]),
    /outside the configured storage directory/,
  );
});

test('goal attachment stripping only removes generated entries, never operator prose', () => {
  const generated = appendGoalAttachments('Use the reference.', [attachment]);
  assert.deepEqual(stripGoalAttachmentSection(generated), {
    message: 'Use the reference.', attachmentCount: 1,
  });

  const authored = [
    'Reword the upload hint.',
    '',
    GOAL_ATTACHMENT_SECTION_HEADING,
    '- that phrasing is confusing, use "attached files" instead',
  ].join('\n');
  assert.deepEqual(stripGoalAttachmentSection(authored), { message: authored, attachmentCount: 0 });

  const quotedPath = [
    'Fix the copy below.',
    '',
    GOAL_ATTACHMENT_SECTION_HEADING,
    '- "notes.png" (image/png): /home/alice/notes.png',
  ].join('\n');
  assert.deepEqual(stripGoalAttachmentSection(quotedPath), { message: quotedPath, attachmentCount: 0 });

  const trailingProse = `${generated}\nPlease crop the second one.`;
  assert.deepEqual(stripGoalAttachmentSection(trailingProse), { message: trailingProse, attachmentCount: 0 });

  assert.deepEqual(stripGoalAttachmentSection('No attachments here.'), {
    message: 'No attachments here.', attachmentCount: 0,
  });
});
