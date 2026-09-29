/**
 * Records why the live plan was created and carries that provenance into the
 * snapshot made when the plan is replaced. Renames are history events too,
 * even though they do not replace the plan JSON.
 */
const MAX_REVISIONS_PER_DRAFT = 50;
const EDIT_COALESCE_MINUTES = 10;
const CAUSES = "'generation', 'refinement', 'manual_edit', 'restore', 'rename', 'unknown'";

function createOriginalPlanHistoryTrigger(knex) {
  return knex.raw(`CREATE TRIGGER task_drafts_plan_history AFTER UPDATE OF plan_json ON task_drafts
    WHEN OLD.plan_json IS NOT NULL AND OLD.plan_json IS NOT NEW.plan_json
    BEGIN
      INSERT INTO task_draft_plan_revisions (draft_id, plan_json, draft_revision, status_before, status_after, replaced_at)
        SELECT OLD.draft_id, OLD.plan_json, OLD.mcp_revision, OLD.status, NEW.status, CURRENT_TIMESTAMP
        WHERE NOT EXISTS (
          SELECT 1 FROM (
            SELECT plan_json, status_before, status_after, is_restore, replaced_at FROM task_draft_plan_revisions
              WHERE draft_id = OLD.draft_id ORDER BY revision_id DESC LIMIT 1
          ) AS latest
          WHERE latest.plan_json = OLD.plan_json
            OR (OLD.status IS NEW.status
              AND latest.is_restore = 0
              AND latest.status_before IS latest.status_after
              AND latest.status_after IS OLD.status
              AND latest.replaced_at > datetime('now', '-${EDIT_COALESCE_MINUTES} minutes'))
        );
      -- Duplicate suppression must still end the edit burst at an operation boundary.
      UPDATE task_draft_plan_revisions
        SET draft_revision = OLD.mcp_revision, status_before = OLD.status,
          status_after = NEW.status, replaced_at = CURRENT_TIMESTAMP
        WHERE OLD.status IS NOT NEW.status AND plan_json = OLD.plan_json
          AND revision_id = (
            SELECT revision_id FROM task_draft_plan_revisions
              WHERE draft_id = OLD.draft_id ORDER BY revision_id DESC LIMIT 1
          );
      DELETE FROM task_draft_plan_revisions
        WHERE draft_id = OLD.draft_id
          AND revision_id NOT IN (
            SELECT revision_id FROM task_draft_plan_revisions
              WHERE draft_id = OLD.draft_id ORDER BY revision_id DESC LIMIT ${MAX_REVISIONS_PER_DRAFT}
          );
    END`);
}

export async function up(knex) {
  await knex.raw(`ALTER TABLE task_drafts ADD COLUMN plan_cause TEXT NULL CHECK (plan_cause IS NULL OR plan_cause IN (${CAUSES}))`);
  await knex.raw(`ALTER TABLE task_draft_plan_revisions ADD COLUMN cause TEXT NULL CHECK (cause IS NULL OR cause IN (${CAUSES}))`);
  await knex.raw('ALTER TABLE task_draft_plan_revisions ADD COLUMN name_before TEXT NULL');
  await knex.raw('ALTER TABLE task_draft_plan_revisions ADD COLUMN name_after TEXT NULL');

  await knex.raw('DROP TRIGGER IF EXISTS task_drafts_plan_history');
  await knex.raw(`CREATE TRIGGER task_drafts_plan_history AFTER UPDATE OF plan_json ON task_drafts
    WHEN OLD.plan_json IS NOT NULL AND OLD.plan_json IS NOT NEW.plan_json
    BEGIN
      INSERT INTO task_draft_plan_revisions (draft_id, plan_json, draft_revision, status_before, status_after, cause, replaced_at)
        SELECT OLD.draft_id, OLD.plan_json, OLD.mcp_revision, OLD.status, NEW.status, OLD.plan_cause, CURRENT_TIMESTAMP
        WHERE NOT EXISTS (
          SELECT 1 FROM (
            SELECT plan_json, status_before, status_after, is_restore, replaced_at FROM task_draft_plan_revisions
              WHERE draft_id = OLD.draft_id ORDER BY revision_id DESC LIMIT 1
          ) AS latest
          WHERE latest.plan_json = OLD.plan_json
            OR (OLD.status IS NEW.status
              AND latest.is_restore = 0
              AND latest.status_before IS latest.status_after
              AND latest.status_after IS OLD.status
              AND latest.replaced_at > datetime('now', '-${EDIT_COALESCE_MINUTES} minutes'))
        );
      -- Duplicate suppression must still end the edit burst at an operation boundary.
      UPDATE task_draft_plan_revisions
        SET draft_revision = OLD.mcp_revision, status_before = OLD.status,
          status_after = NEW.status, cause = OLD.plan_cause, replaced_at = CURRENT_TIMESTAMP
        WHERE OLD.status IS NOT NEW.status AND plan_json = OLD.plan_json
          AND revision_id = (
            SELECT revision_id FROM task_draft_plan_revisions
              WHERE draft_id = OLD.draft_id ORDER BY revision_id DESC LIMIT 1
          );
      DELETE FROM task_draft_plan_revisions
        WHERE draft_id = OLD.draft_id
          AND revision_id NOT IN (
            SELECT revision_id FROM task_draft_plan_revisions
              WHERE draft_id = OLD.draft_id ORDER BY revision_id DESC LIMIT ${MAX_REVISIONS_PER_DRAFT}
          );
    END`);

  await knex.raw(`CREATE TRIGGER task_drafts_name_history AFTER UPDATE OF name ON task_drafts
    WHEN OLD.name IS NOT NEW.name AND OLD.plan_json IS NOT NULL AND OLD.plan_json IS NEW.plan_json
    BEGIN
      INSERT INTO task_draft_plan_revisions
        (draft_id, plan_json, draft_revision, status_before, status_after, cause, name_before, name_after, replaced_at)
        VALUES
        (OLD.draft_id, OLD.plan_json, OLD.mcp_revision, OLD.status, NEW.status, 'rename', OLD.name, NEW.name, CURRENT_TIMESTAMP);
      DELETE FROM task_draft_plan_revisions
        WHERE draft_id = OLD.draft_id
          AND revision_id NOT IN (
            SELECT revision_id FROM task_draft_plan_revisions
              WHERE draft_id = OLD.draft_id ORDER BY revision_id DESC LIMIT ${MAX_REVISIONS_PER_DRAFT}
          );
    END`);
}

export async function down(knex) {
  await knex.raw('DROP TRIGGER IF EXISTS task_drafts_name_history');
  await knex.raw('DROP TRIGGER IF EXISTS task_drafts_plan_history');
  await knex.schema.alterTable('task_draft_plan_revisions', table => {
    table.dropColumn('name_after');
    table.dropColumn('name_before');
    table.dropColumn('cause');
  });
  await knex.schema.alterTable('task_drafts', table => { table.dropColumn('plan_cause'); });
  await createOriginalPlanHistoryTrigger(knex);
}
