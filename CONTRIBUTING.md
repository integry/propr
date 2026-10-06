# Contributing to ProPR

Thanks for your interest in improving ProPR. Bug reports, documentation fixes and code contributions are all welcome.

## Ways to contribute

- **Report a bug or request a feature** in [GitHub Issues](https://github.com/integry/propr/issues). Include your ProPR version (`propr --version`), how you installed it, and the steps to reproduce.
- **Ask a question or share feedback** in [Discord](https://discord.gg/5FjuaQBud).
- **Influence direction** through the [roadmap](ROADMAP.md): every item links to a public issue, and pre-1.0 is when direction is cheapest to change.
- **Report a security vulnerability privately** as described in [SECURITY.md](SECURITY.md). Please do not open a public issue for it.

## Development setup

You need Node.js 22 or newer, Git 2.25 or newer, and Docker with Docker Compose v2.

```bash
git clone https://github.com/integry/propr.git
cd propr
npm ci                 # install workspace dependencies
cp .env.example .env   # then configure GitHub access
# create agent credential directories before the first start, or Docker creates them root-owned
mkdir -p ~/.claude ~/.codex ~/.gemini ~/.vibe /tmp/propr-vibe-prompts
npm run compose:up     # build and run the full stack from source
```

Before running agents, log in to each one you plan to use (for example `claude auth login` for Claude Code) so its credential directory holds real auth state.

Open the Web UI at `http://localhost:5173`. The [source setup tutorial](https://docs.propr.dev/docs/tutorials/setup-source) covers host directories, agent logins, GitHub authentication and running services directly.

### Common scripts

```bash
npm run compose:up     # build and start the stack from source
npm run compose:logs   # tail the services
npm run compose:down   # stop the stack

npm run daemon:dev     # issue-detection daemon (debug logging)
npm run worker:dev     # job worker (debug logging)
npm run dashboard:dev  # dashboard API

npm run images:build   # build all Docker images locally
npm run images:smoke   # smoke-test locally built images
```

### Checks

Run these before opening a pull request:

```bash
npm run lint
npm run typecheck
npm test               # quick suite
npm run test:full      # builds the workspace packages, then runs the full server suite
```

The Web UI has its own checks in `propr-ui/`: `npm run lint`, `npm run typecheck` and `npm test`.

The full suite also runs nightly on `main` (`.github/workflows/test-nightly.yml`). A red night opens a `Nightly test health` issue labelled `nightly-health`, or comments on the one already open, with the run link, failing jobs, a log excerpt and the commit SHA. The next green night comments and closes it. The issue never carries `AI` or `llm-*` labels, so ProPR does not pick it up; fix the failure in a normal pull request.

## Project structure

```
propr/
├── src/            # Daemon, workers, jobs, polling, GitHub handling
├── packages/
│   ├── core/       # Git/worktree management, agents, queue, config, DB migrations
│   ├── api/        # Dashboard REST API, webhooks, authentication
│   ├── cli/        # The `propr` command (published to npm as propr-cli)
│   └── shared/     # Shared model catalog and types
├── propr-ui/       # Web UI (React + Vite)
├── apps/desktop/   # Desktop application
├── docs/           # Docusaurus documentation site
├── docker/         # Launcher and production app images
├── scripts/        # Agent entrypoints, build/compose/release helpers
└── docker-compose*.yml
```

The [architecture docs](https://docs.propr.dev/docs/architecture/overview) explain how the daemon, workers and agent runtime fit together.

## Pull requests

- Keep each pull request focused on one change.
- Follow the patterns of the surrounding code.
- Add or update tests for the behavior you change, and keep the suite passing.
- Update the documentation in `docs/` alongside the code.
- Use the structured logger for output rather than `console.log`.
- Describe what changed and how you verified it in the pull request description.

Most pull requests in this repository are opened by ProPR itself, from branches named `<issue>/<model>-<title>-<timestamp>`. Human-authored branches and pull requests are just as welcome and go through the same review.

## License

ProPR is licensed under the [Apache License 2.0](LICENSE). Unless you state otherwise, contributions you submit are licensed under the same terms, as set out in section 5 of the license.
