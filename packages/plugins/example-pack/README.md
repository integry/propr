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

See [Plugins](../../../docs/docs/features/plugins.md) for the manifest format.
