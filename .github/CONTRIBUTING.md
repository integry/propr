# Contributing to ProPR

Thanks for your interest in improving ProPR. Bug reports, documentation fixes and code contributions are all welcome.

## Ways to contribute

- **Report a bug or request a feature** in [GitHub Issues](https://github.com/integry/propr/issues). Include your ProPR version (`propr --version`), how you installed it, and the steps to reproduce.
- **Ask a question or share feedback** in [Discord](https://discord.gg/VJxDASAE64).
- **Influence direction** through the [roadmap](../docs/ROADMAP.md): every item links to a public issue, and pre-1.0 is when direction is cheapest to change.
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

## Releases

A release starts with one pull request that prepares the release metadata. Pushing the `v<version>` tag of the merged result then runs the **Docker Images** workflow (`.github/workflows/docker-images.yml`), which validates the tag, publishes the images and the npm package, creates the GitHub release and [deploys the hosted UI](https://docs.propr.dev/docs/operations/hosted-ui-release).

The preparation pull request:

1. Bumps the version in the root `package.json`, every release-versioned `@propr` workspace, the desktop package, the matching `package-lock.json` records and internal dependency ranges, `PROPR_VERSION` and the launcher manifest. Independently versioned packages keep their own versions.
2. Renames `## [Unreleased]` in `CHANGELOG.md` to `## [<version>] - <date>`, adds a new empty `## [Unreleased]` above it and updates the comparison links.
3. Writes the release summary, `release-notes/v<version>.md` (see below).
4. Passes `EXPECTED_VERSION=<version> RELEASE_TAG=v<version> RELEASE_CANDIDATE=true npm run release:verify`.

### Release summary

`release-notes/v<version>.md` is the top of the GitHub release. The release job reads it from the release tag and creates the release with `gh release create --notes-file … --generate-notes`, so the summary comes first and GitHub's generated "What's Changed" list of pull requests follows it. [`release-notes/v0.9.2.md`](../release-notes/v0.9.2.md) is an example.

Write it from the version's `CHANGELOG.md` section, for someone deciding whether and how to upgrade. Keep it to roughly 30–50 lines: it is a summary, not a second changelog. It has two sections:

- `## Highlights`: what the release means for a user, grouped by area (for example **Pull requests**, **Automations**, **Agents and models**, **Fixes and security**), in plain language. Do not copy pull request titles. Start with one sentence about the release that links to the changelog at the tag (`https://github.com/integry/propr/blob/v<version>/CHANGELOG.md`) and to the site's what's-new page (`https://propr.dev/whats-new/<version>/`).
- `## Upgrade notes`: behaviour changes, migrations, deprecations and retirements, and anything to do before or after upgrading. Write `None.` when there are none.

`npm run release:verify` fails in release-candidate mode (every pull request's **Validate Changes**) and on the release tag when the current version's file is missing or empty, lacks either section or has an empty one, does not have both links, or still contains a placeholder (`TODO`, `TBD`, `FIXME`, `XXX`, an HTML comment, an `<angle-bracket>` or `{{ }}` slot, or filler text). A release whose GitHub release already exists, for example a re-run, only gets its assets uploaded and keeps its text.

## License

ProPR is licensed under the [Apache License 2.0](../LICENSE). Unless you state otherwise, contributions you submit are licensed under the same terms, as set out in section 5 of the license.
