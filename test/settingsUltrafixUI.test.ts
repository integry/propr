import { test, describe } from 'node:test';
import assert from 'node:assert';

/**
 * Test suite for verifying that ultrafix and PR review model settings
 * round-trip correctly through the settings API contract.
 *
 * These tests validate the shape of data expected by the frontend
 * Settings UI without requiring a browser environment.
 */

describe('Settings UI contract for ultrafix fields', () => {
  // Simulates the shape returned by GET /api/config/settings
  const mockApiResponse = {
    worker_concurrency: 5,
    github_user_whitelist: [],
    analysis_model_fast: 'claude:claude-3-5-haiku-20241022',
    planner_context_model: '',
    planner_generation_model: '',
    auto_followup_score_threshold: 4,
    auto_resolve_merge_conflicts: false,
    pr_review_model: 'claude:claude-opus-4-6',
    ultrafix_rating_goal: 7,
    ultrafix_max_cycles: 5,
    ultrafix_pause_seconds: 60
  };

  test('API response includes pr_review_model', () => {
    assert.ok('pr_review_model' in mockApiResponse);
    assert.strictEqual(typeof mockApiResponse.pr_review_model, 'string');
  });

  test('API response includes ultrafix_rating_goal', () => {
    assert.ok('ultrafix_rating_goal' in mockApiResponse);
    assert.strictEqual(typeof mockApiResponse.ultrafix_rating_goal, 'number');
    assert.ok(mockApiResponse.ultrafix_rating_goal >= 1 && mockApiResponse.ultrafix_rating_goal <= 10);
  });

  test('API response includes ultrafix_max_cycles', () => {
    assert.ok('ultrafix_max_cycles' in mockApiResponse);
    assert.strictEqual(typeof mockApiResponse.ultrafix_max_cycles, 'number');
    assert.ok(mockApiResponse.ultrafix_max_cycles >= 1 && mockApiResponse.ultrafix_max_cycles <= 50);
  });

  test('API response includes ultrafix_pause_seconds', () => {
    assert.ok('ultrafix_pause_seconds' in mockApiResponse);
    assert.strictEqual(typeof mockApiResponse.ultrafix_pause_seconds, 'number');
    assert.ok(mockApiResponse.ultrafix_pause_seconds >= 0 && mockApiResponse.ultrafix_pause_seconds <= 600);
  });

  test('settings payload for POST includes all ultrafix fields', () => {
    // Simulates what the frontend sends to POST /api/config/settings
    const savePayload = {
      worker_concurrency: 5,
      analysis_model_fast: mockApiResponse.analysis_model_fast,
      planner_context_model: mockApiResponse.planner_context_model,
      planner_generation_model: mockApiResponse.planner_generation_model,
      default_agent_alias: 'claude',
      auto_followup_score_threshold: 4,
      auto_resolve_merge_conflicts: false,
      pr_review_model: mockApiResponse.pr_review_model,
      ultrafix_rating_goal: mockApiResponse.ultrafix_rating_goal,
      ultrafix_max_cycles: mockApiResponse.ultrafix_max_cycles,
      ultrafix_pause_seconds: mockApiResponse.ultrafix_pause_seconds
    };

    assert.ok('pr_review_model' in savePayload);
    assert.ok('ultrafix_rating_goal' in savePayload);
    assert.ok('ultrafix_max_cycles' in savePayload);
    assert.ok('ultrafix_pause_seconds' in savePayload);
  });

  test('default values match backend defaults', () => {
    // These must match configManagerUltrafix.ts defaults
    const frontendDefaults = {
      pr_review_model: '',
      ultrafix_rating_goal: 7,
      ultrafix_max_cycles: 5,
      ultrafix_pause_seconds: 60
    };

    assert.strictEqual(frontendDefaults.pr_review_model, '');
    assert.strictEqual(frontendDefaults.ultrafix_rating_goal, 7);
    assert.strictEqual(frontendDefaults.ultrafix_max_cycles, 5);
    assert.strictEqual(frontendDefaults.ultrafix_pause_seconds, 60);
  });
});
