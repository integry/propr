import assert from "node:assert/strict";
import { test } from "node:test";
import { getAllDisplaySettings, getExtraConfigSetting } from "./settingCommands.js";
import type { SystemSettings } from "../api/settings.js";

const SETTINGS: SystemSettings = {
  default_agent_alias: "codex",
  worker_concurrency: 2,
  github_user_whitelist: ["octocat"],
  analysis_model_fast: "fast-model",
  planner_context_model: "context-model",
  planner_generation_model: "generation-model",
  auto_followup_score_threshold: 7,
  auto_resolve_merge_conflicts: true,
  pr_review_model: "",
  pr_review_prompt: "",
  ultrafix_rating_goal: 8,
  ultrafix_max_cycles: 3,
  ultrafix_pause_seconds: 5,
};

test("getExtraConfigSetting reads only the requested extra config endpoint", async () => {
  const endpoints: string[] = [];
  const value = await getExtraConfigSetting("followup-keywords", async (endpoint) => {
    endpoints.push(endpoint);
    return { followup_keywords: ["/fix", "/ultrafix"] };
  });

  assert.deepEqual(value, ["/fix", "/ultrafix"]);
  assert.deepEqual(endpoints, ["/api/config/followup-keywords"]);
});

test("getAllDisplaySettings includes label and keyword config values", async () => {
  const responses: Record<string, Record<string, unknown>> = {
    "/api/config/pr-label": { pr_label: "propr" },
    "/api/config/ai-primary-tag": { ai_primary_tag: "ai" },
    "/api/config/primary-processing-labels": { primary_processing_labels: ["propr", "ai"] },
    "/api/config/followup-keywords": { followup_keywords: ["/fix", "/ultrafix"] },
  };

  const displaySettings = await getAllDisplaySettings(SETTINGS, async (endpoint) => responses[endpoint]);

  assert.equal(displaySettings.worker_concurrency, 2);
  assert.equal(displaySettings["pr-label"], "propr");
  assert.equal(displaySettings["ai-primary-tag"], "ai");
  assert.deepEqual(displaySettings["primary-processing-labels"], ["propr", "ai"]);
  assert.deepEqual(displaySettings["followup-keywords"], ["/fix", "/ultrafix"]);
});
