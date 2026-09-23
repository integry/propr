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
4. **Access observability** — a durable MCP access log and its admin read API.
5. **MCP Log UI** — a Logs navigation group holding the existing LLM Log and
   the new MCP Log.

Each capability lands as its own pull request against this branch. The
authoritative capability mapping stays in `docs/mcp-coverage.md`, which is
reconciled against the shipped code before this epic merges.
