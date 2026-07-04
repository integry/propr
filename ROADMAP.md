# Roadmap

Direction, not dates. Themes below are ordered roughly by intent; every item
links to a public issue where the actual state lives. Pre-1.0 is when
direction is cheapest to change — open an issue or make the case in
[Discord](https://discord.gg/5FjuaQBud).

_Last reviewed: 2026-07-04._

## CLI for automation

Driving ProPR entirely from CI and scripts.

- `--json` on every mutating command + a documented exit-code contract — [#1671](https://github.com/integry/propr/issues/1671)
- Metrics and LLM-cost export — [#1675](https://github.com/integry/propr/issues/1675)
- Log following (`log --follow`, `task logs -f`) — [#1676](https://github.com/integry/propr/issues/1676)
- `propr teardown` — [#1677](https://github.com/integry/propr/issues/1677)
- Version-skew / update notice — [#1678](https://github.com/integry/propr/issues/1678)
- Small-updates batch (task followup/import, revert dry-run, completions, config profiles, …) — [#1681](https://github.com/integry/propr/issues/1681)

## Task & plan lifecycle

- Plan execution controls: pause / resume / revise / execution settings — [#1673](https://github.com/integry/propr/issues/1673)

## Documentation & site

- Dashboard HTTP API reference (monitoring & integrations)
- Product videos and fresh captures across the site and docs (scripts are
  written; production pending)

## Connect (hosted relay)

- Public status page
- Centralized GitHub login for the hosted UI across customer instances

## Code health

- CLI command-layer refactor: shared error handling, table/format helpers,
  tests for `ConfigManager` and the API client — [#1679](https://github.com/integry/propr/issues/1679)

## Non-goals (for now)

- GitLab / Bitbucket support — the loop is deliberately built on GitHub's APIs
- Hosting your code or your agents — ProPR stays self-hosted; Connect relays
  events only
