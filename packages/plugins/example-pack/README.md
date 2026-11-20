# Example pack

A development plugin used by ProPR's own tests and as a reference for plugin
authors. It is hidden from the plugin catalog unless `PROPR_PLUGINS_DEVELOPMENT=1`
is set.

It contributes:

- **example-remote**: a remote MCP server at `https://mcp.example.com/mcp`,
  signed in through the `example-account` OAuth connection. The endpoint does
  not exist; it only exercises the manifest shape.
- **example-local**: a local MCP server from the pinned npm package
  `propr-fixture-mcp@1.0.0`, the package ProPR's package server tests publish to
  a local registry. Its `FIXTURE_TOKEN` variable comes from the `example-token`
  connection. The package is not on the public npm registry, so
  `npm run plugins:check -- --online` reports it as not found unless
  `--registry` points at the test registry.
- **example-notes**: a skill that tells the agent how to write short notes.
- **example-weekly-digest**: a report-only automation template.
- **/example-notes**: a `prompt` command on pull requests and issues. On a
  pull request it queues a follow-up, on an issue an implementation task, that
  writes release notes with the `example-notes` skill and the `example-remote`
  read server attached. The rest of the command line, as in
  `/example-notes focus on the API`, is passed to the task as untrusted text.
- **/example-status**: a `handler` command on pull requests and issues. It
  starts no task: `reportCommand` in `handlers.ts` receives the comment's
  repository, number, author and argument as a delivery of kind `command`,
  shown in the plugin's Activity, and logs them.
- **recordEvent** (`handlers.ts`): a handler that keeps the newest journal
  event per repository as a cursor in `ctx.state` and logs a task event's task
  state. `../test/testing.test.ts` tests it with the plugin test kit.

See [Plugins](../../../docs/docs/features/plugins.md) for the manifest format.
