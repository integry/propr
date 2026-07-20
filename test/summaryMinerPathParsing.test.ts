import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';

import { closeConnection } from '../packages/core/src/db/connection.js';
import { parseBatchResponse } from '../packages/core/src/services/relevance/summaryMinerBatch.js';
import {
  extractRepositoryDirectories,
  normalizeSummaryPath,
  parseBatchDirectoryResponse,
  resolveExpectedSummaryPath
} from '../packages/core/src/services/relevance/summaryMinerDirectoryHelpers.js';

describe('summary miner path parsing', () => {
  after(async () => {
    await closeConnection();
  });

  test('normalizes Antigravity absolute workspace paths', () => {
    assert.equal(
      normalizeSummaryPath('/home/node/workspace/integry/agent-tank-website/packages/website'),
      'integry/agent-tank-website/packages/website'
    );
  });

  test('keeps directory aggregation inside each repository boundary', () => {
    const digvinDirectories = extractRepositoryDirectories([
      'integry/digvin/README.md',
      'integry/digvin/docs/PLAN.md'
    ], 'integry/digvin');
    const proprDirectories = extractRepositoryDirectories([
      'integry/propr/README.md',
      'integry/propr/packages/core/index.ts'
    ], 'integry/propr');

    assert.deepEqual(digvinDirectories, ['integry/digvin', 'integry/digvin/docs']);
    assert.deepEqual(proprDirectories, ['integry/propr', 'integry/propr/packages', 'integry/propr/packages/core']);
    assert.ok(!digvinDirectories.includes('integry'));
    assert.ok(!proprDirectories.includes('integry'));
  });

  test('resolves absolute directory paths to expected canonical paths', () => {
    const parsed = parseBatchDirectoryResponse(
      JSON.stringify({
        summaries: [{
          path: '/home/node/workspace/integry/agent-tank-website/packages/website',
          summary: 'Contains the Agent Tank website package.'
        }]
      }),
      ['integry/agent-tank-website/packages/website']
    );

    assert.deepEqual(parsed, [{
      dirPath: 'integry/agent-tank-website/packages/website',
      summary: 'Contains the Agent Tank website package.'
    }]);
  });

  test('accepts bare array directory summaries', () => {
    const parsed = parseBatchDirectoryResponse(
      JSON.stringify([{
        dirPath: 'integry/gitfix/packages/core/src',
        summary: 'Contains core service code.'
      }]),
      ['integry/gitfix/packages/core/src']
    );

    assert.deepEqual(parsed, [{
      dirPath: 'integry/gitfix/packages/core/src',
      summary: 'Contains core service code.'
    }]);
  });

  test('accepts a single directory summary object without a path for one-directory batches', () => {
    const parsed = parseBatchDirectoryResponse(
      JSON.stringify({ summary: 'Contains the root application services.' }),
      ['integry/gitfix/packages/core']
    );

    assert.deepEqual(parsed, [{
      dirPath: 'integry/gitfix/packages/core',
      summary: 'Contains the root application services.'
    }]);
  });

  test('uses plain text as a summary for one-directory batches', () => {
    const parsed = parseBatchDirectoryResponse(
      'This directory contains the indexing services and helpers. It coordinates repository summarization and persistence.',
      ['integry/gitfix/packages/core/src/services/relevance']
    );

    assert.deepEqual(parsed, [{
      dirPath: 'integry/gitfix/packages/core/src/services/relevance',
      summary: 'This directory contains the indexing services and helpers. It coordinates repository summarization and persistence.'
    }]);
  });

  test('resolves file paths with repository prefixes back to batch-relative paths', () => {
    const parsed = parseBatchResponse(
      JSON.stringify({
        summaries: [{
          path: '/home/node/workspace/integry/agent-tank-website/packages/website/index.html',
          summary: 'Defines the website HTML shell.'
        }]
      }),
      ['packages/website/index.html']
    );

    assert.deepEqual(parsed, [{
      path: 'packages/website/index.html',
      summary: 'Defines the website HTML shell.'
    }]);
  });

  test('does not resolve ambiguous suffix-only paths', () => {
    assert.equal(
      resolveExpectedSummaryPath('/home/node/workspace/packages/website/index.html', [
        'apps/admin/packages/website/index.html',
        'apps/public/packages/website/index.html'
      ]),
      null
    );
  });
});
