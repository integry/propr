import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createIndexingQueueDeduplicationId,
  createIndexingQueueJobId,
  createLegacyIndexingRunIdForJob,
} from '../src/services/relevance/indexingQueueIdentity.js';

test('indexing queue identities normalize whitespace and the default branch', () => {
  assert.equal(
    createIndexingQueueDeduplicationId(' Integry/ProPR ', ' main '),
    createIndexingQueueDeduplicationId('integry/propr', 'main')
  );
  assert.equal(
    createIndexingQueueDeduplicationId('integry/propr', ''),
    createIndexingQueueDeduplicationId('integry/propr')
  );
  assert.equal(
    createIndexingQueueJobId('integry/propr', ' main ', 'run-1'),
    createIndexingQueueJobId('integry/propr', 'main', 'run-1')
  );
  assert.equal(
    createLegacyIndexingRunIdForJob('integry/propr', ' main ', 'job-1'),
    createLegacyIndexingRunIdForJob('integry/propr', 'main', 'job-1')
  );
});

test('indexing queue identities use the canonical GitHub repository grammar', () => {
  for (const repository of ['owner--name/repo', 'owner/repo:name', 'owner-only']) {
    assert.throws(
      () => createIndexingQueueDeduplicationId(repository),
      /GitHub owner\/name identity/
    );
  }
});
