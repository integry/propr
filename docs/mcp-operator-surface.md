# MCP operator surface (epic scaffold)

This epic branch aggregates the work that turns ProPR's MCP server from a
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
   on the connected-apps page. The **MCP Log** navigation entry planned for the
   web UI has not landed on this branch: the sidebar still ends at **LLM Log**,
   and the access log is read through `GET /api/admin/mcp/logs`.

Each capability lands as its own pull request against this branch. The
authoritative capability mapping is `docs/mcp-coverage.md` and the operator
walkthrough is `docs/mcp.md`; both were reconciled against the shipped code in
`packages/api/mcp/` on 2026-09-25, and
`packages/api/test/mcpOperatorSurface.test.ts` exercises the surface end to end.
