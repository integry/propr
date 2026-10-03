# MCP Connections and Operator Tools

MCP lets a connected coding or chat client inspect and operate ProPR using scoped authorization. It is disabled by default. Administrators use **Settings → Integrations → MCP Server** to manage enablement and the allowed scope ceiling (default: `read`, `plan`, `review`). The UI-managed path derives an HTTPS origin and encryption key from existing instance configuration and persists an instance identity. An explicit `MCP_ENABLED=true` selects environment-managed configuration, where the settings page shows the status but no toggle or ceiling; `false` prevents UI enablement. Missing configuration is shown as a setup problem; demo mode cannot enable MCP.

![MCP server settings with enablement, public endpoint and scope controls](/img/screenshots/0.9.0/mcp-settings.png)

## Consent and connected apps

Connect the client to the instance's `/api/mcp` endpoint. Sign in through the browser and review the requested permissions and repository selection. Optional scopes begin unchecked. Select only the requested capabilities and repositories you intend to grant; refresh cannot expand the grant. A rejected GitHub session returns you to sign-in.

The repository picker shows familiar repository icons, starred repositories, a name filter and selection counts. Filtering does not clear a selected repository.

![MCP consent repository picker with starred grouping, icons, selection counts and filter](/img/screenshots/0.9.0/mcp-consent.png)

Open **Connected apps** (`/mcp/apps`) to inspect grants and revoke access. The list shows repository access, permissions, last use and request counts. Administrators can inspect **Logs → MCP Log** for tool/resource names, outcomes, timing and operation handles; arguments and result bodies are excluded from the log.

![Connected app grant showing permissions, repository access and a revoke action](/img/screenshots/0.9.0/mcp-apps.png)

## Common operator workflows

| Need | Tools |
| --- | --- |
| Current work and blockers | `get_current_activity` |
| Tasks joined to their pull request's head, review, checks and ultrafix state | `get_work_overview` |
| Finished work in a recent window | `get_recent_activity` (up to seven days) |
| Goal progress and corrections | `get_goal`, `list_goal_inputs` |
| Tasks or goals by lifecycle | `list_tasks`, `list_goals` with `state` and optional `repository` |
| Plans by status | `list_plans` with `status`: `active`, an exact persisted status, or `all` (default) |
| Start a bounded change | `create_task`, then `get_operation` or `get_task_submission` |
| Find what you started and whether it finished | `list_operations`, then `get_operation` |
| PR inventory and review fixes | `list_pull_requests`, `fix_review_findings` with `findingIds` and/or `suggestionIds` |
| Visual previews published for a task or PR (images; videos are metadata only) | `list_visual_previews`, `get_visual_preview` |
| Screenshots embedded in a PR/issue comment or description (images; videos are metadata only) | `get_pull_request_discussion` `attachments`, then `get_comment_attachment` |
| Product docs and where a setting lives | `search_docs`, `get_doc`, `find_setting` |

Mutations require their corresponding scopes and repository access, and return durable receipts. Queue acceptance is not completion. Keep idempotency keys stable when retrying the same request, and repeat its arguments exactly. Failures return a structured error with a stable `code`, the `stage` where it failed and whether it is `retryable`. See the [full operator/setup reference](https://github.com/integry/propr/blob/main/docs/mcp.md) and [tool coverage](https://github.com/integry/propr/blob/main/docs/mcp-coverage.md) for schemas, Connect registration and deployment requirements.
