# Run ProPR From Your Chat Assistant

Connect a chat assistant to ProPR through MCP to inspect running work, start tasks, and act on pull requests without leaving the conversation.

## Connect and authorize

Use a chat client that supports MCP with OAuth. Ask your instance administrator for the enabled MCP endpoint, typically `https://your-instance.example/api/mcp`, and add it as a connection in the client. Sign in through the browser consent flow and choose the repositories and permissions the assistant needs. Read-only access is enough to inspect activity; starting tasks, reviewing, and merging require the corresponding permissions.

MCP must be enabled and configured on the instance first. Client support varies, including support in voice mode. Never paste instance secrets or GitHub tokens into chat.

## Try a workflow

- Ask what is running, queued, or blocked across the authorized repositories.
- Ask for details about a task or pull request before deciding on the next action.
- Request a new task, a review, or a fix with the appropriate permissions, then check its progress. An accepted task is not yet completed work.
- Ask what you started in the last hour and whether it finished, or ask how a ProPR feature or setting works.

Use [the MCP access log](./web-ui.md#mcp-access-log) to inspect the assistant's calls. Manage or revoke direct instance connections at `/mcp/apps` on your instance.
