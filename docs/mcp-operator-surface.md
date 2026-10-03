# MCP operator surface

This page summarizes the work that turns ProPR's MCP server from a
per-object read/write catalog into a surface an operator's connected agent can
actually run an instance from.

The delivered capabilities are:

1. **Activity digest** — `get_current_activity` and `get_recent_activity`
   answer "what is happening now?" and "what has been done in the last N
   minutes?" across every repository in the grant, with routine system
   notification noise filtered out and critical errors and blockers kept.
2. **Goal and task depth** — repository-optional listing, one-call detail that
   covers both current activity and completed progress, and corrective
   messaging for a running goal.
3. **Pull request surface** — PR inventory with ProPR task/goal correlation,
   newest-first discussion, ordinary follow-up comments, model routing by
   managed label, and starting and stopping ultrafix.
4. **Access observability** — a durable MCP access log, its admin read and
   stats API behind `instance.manage_settings`, and per-app last-used activity
   on the connected-apps page. The web UI reads the log on the **MCP Log** page
   (`/mcp-logs`), reached from the sidebar's collapsible **Logs** group next to
   **LLM Log** (and from **More** on mobile). The entry and the page are shown
   only to users with the `instance.manage_settings` permission; the page reads
   `GET /api/admin/mcp/logs` and `GET /api/admin/mcp/logs/stats`.
5. **Receipts and errors** — durable lifecycle state, timestamps, artifacts,
   task-submission and ultrafix progress, recent receipt discovery through
   `list_operations`, and one sanitized structured error envelope with stable
   codes, stages, retry guidance and nested causes.
6. **Product documentation** — `list_docs`, `search_docs` and `get_doc` expose
   bundled, versioned and bounded product/operator documentation, including the
   MCP guide at `mcp/guide`.
7. **Visual previews** — `list_visual_previews` discovers published evidence
   for one task or pull request and `get_visual_preview` returns a bounded image;
   `get_comment_attachment` returns a bounded image embedded in any PR/issue
   comment through the caller's GitHub access, without ProPR managed storage;
   video evidence remains metadata-only and linked back to GitHub.
8. **Configuration reachability** — trigger access reads/updates distinguish
   persisted and environment-owned values, while `find_setting` explains each
   setting's UI, MCP, CLI or environment location and access requirements.

The authoritative capability mapping is `docs/mcp-coverage.md` and the operator
walkthrough is `docs/mcp.md`. The operator flow remains covered by
`packages/api/test/mcpOperatorSurface.test.ts`; the combined observable contract
is covered by `packages/api/test/mcpObservableSurface.test.ts`.
