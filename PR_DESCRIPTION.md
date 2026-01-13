Refactored finalization flow and added auto-title generation.

- **Frontend:** Updated `TaskPlannerPage.tsx` to refetch the draft instead of navigating to the dashboard upon finalization. This keeps the user in context.
- **Backend:**
    - Updated `taskExecutionService.ts` to generate a descriptive title using LLM (Haiku) based on the plan summary during the execution phase. This title is saved to the `task_drafts` table.
    - Updated `plannerRoutes.ts` to map the `name` field to `task_title` in API responses (`getDraft`, `updateDraft`) to ensure the frontend displays the new title correctly in the `ApprovedPlanView`.

These changes solve the issue of losing context after finalization and providing meaningful names for generated tasks.