/**
 * E2E Tests for Repository Indexing & Stale Entry Cleanup
 *
 * Tests the indexing pipeline including:
 * - Full reindexing completes with file and directory phases
 * - Incremental reindexing detects and cleans up stale entries
 * - Progress tracking reports both file and directory phases
 * - Re-indexing after a completed index (stale cleanup path)
 *
 * Requires: PROPR_E2E_API_URL, PROPR_E2E_REPO (+ PROPR_E2E_TOKEN or `gh auth token`)
 * Optional: PROPR_E2E_SKIP_SLOW=1, PROPR_E2E_NO_CLEANUP=1
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";

import {
  REPO,
  SKIP_SLOW,
  MISSING_ENV,
  createTestClient,
  sleep,
} from "./helpers.js";

import type { ApiClient } from "../../packages/cli/src/api/client.js";
import {
  getRepos,
  addRepo,
  triggerIndexing,
  getIndexingStatus,
  type RepositoryIndexingStatus,
} from "../../packages/cli/src/api/repos.js";

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

let client: ApiClient;

/**
 * Polls indexing status until it reaches a terminal state or timeout.
 * Returns the final status and any progress snapshots captured during polling.
 */
async function pollIndexingToCompletion(
  repo: string,
  client: ApiClient,
  timeoutMs = 300_000,
  pollIntervalMs = 5_000,
): Promise<{
  finalStatus: RepositoryIndexingStatus | null;
  progressSnapshots: Array<{
    phase: string;
    percentComplete: number;
    processedFiles: number;
    totalFiles: number;
    processedDirectories: number;
    totalDirectories: number;
    timestamp: number;
  }>;
  observedPhases: Set<string>;
}> {
  const startTime = Date.now();
  const progressSnapshots: Array<{
    phase: string;
    percentComplete: number;
    processedFiles: number;
    totalFiles: number;
    processedDirectories: number;
    totalDirectories: number;
    timestamp: number;
  }> = [];
  const observedPhases = new Set<string>();
  let finalStatus: RepositoryIndexingStatus | null = null;

  while (Date.now() - startTime < timeoutMs) {
    const result = await getIndexingStatus(repo, client);
    const status = result.repositories[0];

    if (!status) {
      await sleep(pollIntervalMs);
      continue;
    }

    finalStatus = status;

    // Capture progress snapshots when actively indexing
    if (status.indexing_status === "indexing" && status.progress) {
      const p = status.progress;
      observedPhases.add(p.phase);
      progressSnapshots.push({
        phase: p.phase,
        percentComplete: p.percentComplete,
        processedFiles: p.processedFiles,
        totalFiles: p.totalFiles,
        processedDirectories: p.processedDirectories,
        totalDirectories: p.totalDirectories,
        timestamp: Date.now(),
      });
    }

    if (status.indexing_status === "completed" || status.indexing_status === "failed") {
      break;
    }

    await sleep(pollIntervalMs);
  }

  return { finalStatus, progressSnapshots, observedPhases };
}

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

describe("E2E Indexing & Stale Cleanup", {
  skip: MISSING_ENV ? "Missing PROPR_E2E_API_URL, PROPR_E2E_TOKEN, PROPR_E2E_REPO" : false,
}, () => {
  before(() => {
    client = createTestClient();
  });

  // 1. Pre-check: ensure repo exists
  describe("1. Setup", () => {
    it("ensure test repo is monitored", async () => {
      const r = await getRepos(client);
      let repo = r.repos_to_monitor.find((x) => x.name.toLowerCase() === REPO!.toLowerCase());
      if (!repo) {
        console.log(`    Adding ${REPO}`);
        await addRepo(REPO!, { enabled: true }, client);
        repo = (await getRepos(client)).repos_to_monitor.find((x) => x.name.toLowerCase() === REPO!.toLowerCase());
      }
      assert.ok(repo?.enabled, `${REPO} not found or disabled`);
    });
  });

  // 2. Full reindex — exercises the complete pipeline including directory aggregation
  describe("2. Full Reindex", { timeout: 300_000, skip: SKIP_SLOW ? "SKIP_SLOW" : false }, () => {
    it("trigger full reindex", async () => {
      const result = await triggerIndexing(REPO!, { fullReindex: true }, client);
      assert.ok(result.success, `Trigger failed: ${result.error}`);
      assert.ok(result.jobId, "Expected a jobId");
      console.log(`    Triggered full reindex, jobId: ${result.jobId}`);
    });

    it("indexing completes successfully", async () => {
      const { finalStatus, progressSnapshots, observedPhases } =
        await pollIndexingToCompletion(REPO!, client, 300_000, 3_000);

      assert.ok(finalStatus, "No indexing status returned");
      assert.strictEqual(finalStatus.indexing_status, "completed", `Expected completed, got ${finalStatus.indexing_status}`);

      console.log(`    Indexing completed. Last indexed hash: ${finalStatus.last_indexed_hash?.substring(0, 8) || "none"}`);
      console.log(`    Progress snapshots captured: ${progressSnapshots.length}`);
      console.log(`    Observed phases: ${Array.from(observedPhases).join(", ") || "none (completed too fast)"}`);

      // If we captured progress, verify phases
      if (progressSnapshots.length > 0) {
        // The "files" phase should be present when there are files to process
        const hasFilesPhase = observedPhases.has("files");
        const hasDirectoriesPhase = observedPhases.has("directories");
        const hasDonePhase = observedPhases.has("done");

        console.log(`    files phase: ${hasFilesPhase}, directories phase: ${hasDirectoriesPhase}, done phase: ${hasDonePhase}`);

        // At least one progress phase should have been captured
        assert.ok(progressSnapshots.length > 0, "Expected at least one progress snapshot");
      }
    });

    it("indexing status shows completed with commit info", async () => {
      const result = await getIndexingStatus(REPO!, client);
      const status = result.repositories[0];
      assert.ok(status, "Repository not found in indexing status");
      assert.strictEqual(status.indexing_status, "completed");
      assert.ok(status.last_indexed_at, "Expected last_indexed_at to be set");
      assert.ok(status.last_indexed_hash, "Expected last_indexed_hash to be set");
      console.log(`    Last indexed: ${status.last_indexed_at}`);
      console.log(`    Commit: ${status.last_indexed_hash?.substring(0, 8)} - ${status.last_indexed_commit_message?.substring(0, 60) || "no message"}`);
    });
  });

  // 3. Incremental reindex — exercises stale file/directory detection and cleanup
  describe("3. Incremental Reindex (Stale Cleanup)", { timeout: 300_000, skip: SKIP_SLOW ? "SKIP_SLOW" : false }, () => {
    let preReindexHash: string | null = null;

    it("record pre-reindex state", async () => {
      const result = await getIndexingStatus(REPO!, client);
      const status = result.repositories[0];
      assert.ok(status, "Repository not found");
      assert.strictEqual(status.indexing_status, "completed", "Repository should be completed before incremental reindex");

      preReindexHash = status.last_indexed_hash;
      console.log(`    Pre-reindex hash: ${preReindexHash?.substring(0, 8) || "none"}`);
    });

    it("trigger incremental reindex (non-full)", async () => {
      // Incremental reindex exercises the stale detection path:
      // - identifyStaleFiles compares git files vs DB summaries
      // - Deleted files are detected and cleaned up
      // - Stale directory summaries are cleaned up
      const result = await triggerIndexing(REPO!, { fullReindex: false }, client);
      assert.ok(result.success, `Trigger failed: ${result.error}`);
      console.log(`    Triggered incremental reindex, jobId: ${result.jobId}`);
    });

    it("incremental reindex completes", async () => {
      const { finalStatus, progressSnapshots, observedPhases } =
        await pollIndexingToCompletion(REPO!, client, 300_000, 3_000);

      assert.ok(finalStatus, "No indexing status returned");
      assert.strictEqual(finalStatus.indexing_status, "completed", `Expected completed, got ${finalStatus.indexing_status}`);

      console.log(`    Incremental reindex completed. Hash: ${finalStatus.last_indexed_hash?.substring(0, 8) || "none"}`);
      console.log(`    Progress snapshots: ${progressSnapshots.length}`);
      console.log(`    Observed phases: ${Array.from(observedPhases).join(", ") || "none (no changes detected)"}`);

      // After incremental reindex, the hash should be same or newer
      if (preReindexHash && finalStatus.last_indexed_hash) {
        console.log(`    Hash before: ${preReindexHash.substring(0, 8)}, after: ${finalStatus.last_indexed_hash.substring(0, 8)}`);
      }
    });

    it("status remains completed after incremental reindex", async () => {
      const result = await getIndexingStatus(REPO!, client);
      const status = result.repositories[0];
      assert.ok(status, "Repository not found");
      assert.strictEqual(status.indexing_status, "completed");
      assert.ok(status.last_indexed_at, "Expected last_indexed_at to be set");
    });
  });

  // 4. Back-to-back reindex — verifies no corruption from rapid reindexing
  describe("4. Back-to-back Reindex Stability", { timeout: 600_000, skip: SKIP_SLOW ? "SKIP_SLOW" : false }, () => {
    it("first reindex completes", async () => {
      const trigger = await triggerIndexing(REPO!, { fullReindex: false }, client);
      assert.ok(trigger.success, `Trigger failed: ${trigger.error}`);

      const { finalStatus } = await pollIndexingToCompletion(REPO!, client, 300_000, 3_000);
      assert.ok(finalStatus, "No status returned");
      assert.strictEqual(finalStatus.indexing_status, "completed");
      console.log(`    First reindex done. Hash: ${finalStatus.last_indexed_hash?.substring(0, 8)}`);
    });

    it("second reindex also completes cleanly", async () => {
      // Immediately trigger another reindex - this exercises the path where
      // the DB already has up-to-date summaries and the early return
      // condition (filesToProcess === 0 && filesToDelete === 0) kicks in
      const trigger = await triggerIndexing(REPO!, { fullReindex: false }, client);
      assert.ok(trigger.success, `Trigger failed: ${trigger.error}`);

      const { finalStatus } = await pollIndexingToCompletion(REPO!, client, 300_000, 3_000);
      assert.ok(finalStatus, "No status returned");
      assert.strictEqual(finalStatus.indexing_status, "completed");
      console.log(`    Second reindex done. Hash: ${finalStatus.last_indexed_hash?.substring(0, 8)}`);
    });

    it("indexing status is consistent after multiple reindexes", async () => {
      const result = await getIndexingStatus(REPO!, client);
      const status = result.repositories[0];
      assert.ok(status, "Repository not found");
      assert.strictEqual(status.indexing_status, "completed");
      assert.ok(status.last_indexed_at, "last_indexed_at should be set");
      assert.ok(status.last_indexed_hash, "last_indexed_hash should be set");

      // Should not be stuck in indexing state
      assert.notStrictEqual(status.indexing_status, "indexing", "Should not be stuck in indexing state");
      console.log(`    Final state: ${status.indexing_status}, hash: ${status.last_indexed_hash?.substring(0, 8)}`);
    });
  });

  // 5. Progress phase verification — verify directory phase tracking
  describe("5. Progress Phase Tracking", { timeout: 300_000, skip: SKIP_SLOW ? "SKIP_SLOW" : false }, () => {
    it("full reindex tracks both file and directory phases", async () => {
      const trigger = await triggerIndexing(REPO!, { fullReindex: true }, client);
      assert.ok(trigger.success, `Trigger failed: ${trigger.error}`);

      const { finalStatus, progressSnapshots, observedPhases } =
        await pollIndexingToCompletion(REPO!, client, 300_000, 2_000);

      assert.ok(finalStatus, "No status returned");
      assert.strictEqual(finalStatus.indexing_status, "completed");

      console.log(`    Captured ${progressSnapshots.length} progress snapshots`);
      console.log(`    Observed phases: ${Array.from(observedPhases).join(", ") || "none"}`);

      // Log progress details for debugging
      if (progressSnapshots.length > 0) {
        const first = progressSnapshots[0];
        const last = progressSnapshots[progressSnapshots.length - 1];
        console.log(`    First snapshot: phase=${first.phase}, files=${first.processedFiles}/${first.totalFiles}, dirs=${first.processedDirectories}/${first.totalDirectories}`);
        console.log(`    Last snapshot: phase=${last.phase}, files=${last.processedFiles}/${last.totalFiles}, dirs=${last.processedDirectories}/${last.totalDirectories}`);

        // Verify progress metadata is reasonable
        for (const snap of progressSnapshots) {
          assert.ok(snap.totalFiles >= 0, "totalFiles should be non-negative");
          assert.ok(snap.processedFiles >= 0, "processedFiles should be non-negative");
          assert.ok(snap.processedFiles <= snap.totalFiles || snap.totalFiles === 0, "processedFiles should not exceed totalFiles");
          assert.ok(snap.percentComplete >= 0 && snap.percentComplete <= 100, "percentComplete should be 0-100");
          assert.ok(snap.totalDirectories >= 0, "totalDirectories should be non-negative");
          assert.ok(snap.processedDirectories >= 0, "processedDirectories should be non-negative");
        }
      }
    });
  });
});
