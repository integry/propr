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

Before a release is tagged, `EXPECTED_VERSION=<version> RELEASE_TAG=v<version> RELEASE_CANDIDATE=true npm run release:verify` checks that the release metadata is consistent. Pushing the `v<version>` tag then runs the **Docker Images** workflow (`.github/workflows/docker-images.yml`), which publishes the images and the npm package, creates the GitHub release and [deploys the hosted UI](https://docs.propr.dev/docs/operations/hosted-ui-release). Release Rollout then builds the desktop preview pre-releases and the preview CLI bundle (below); demo.propr.dev and the site are updated after it.

### Desktop previews and the preview CLI bundle

When Docker Images succeeds for the tag push, the **Release Rollout** workflow (`.github/workflows/release-rollout.yml`) starts on its own. To start it by hand, for example after a manual Docker Images run or to re-run a tag:

```bash
gh workflow run release-rollout.yml --ref main -f release_tag=v<version>
```

It uses the tag commit as the source revision and runs the steps that used to be separate dispatches, in order, passing each output (image digests, run ids) to the next:

1. Preview Runtime Images `publish-agent`, then `publish` (the `linux/amd64` managed agent, then the two-architecture app and UI images).
2. In parallel: Desktop Linux Preview Release `stage-draft`, then Desktop Linux Authenticated Preview `sign-draft` and `publish-draft`; the Desktop macOS Preview Release; and the Preview CLI Bundle for ProPR Hosted.

Each step calls the existing workflow, so it waits at the same protected environments for the same reviewers: `desktop-linux-preview-runtime-publication`, `desktop-linux-rpm-signing`, `desktop-linux-preview-publication` and `desktop-macos-preview-publication`. The run summary starts with the plan and ends with one line per step.

Re-running for a tag is safe. The first job finds the runtime images and published preview pre-releases that already exist for the tag commit, skips those steps and passes their digests on. To resume a run that stopped part-way (a rejected approval, a flaky runner), re-run its failed jobs rather than starting a new run: a new run rebuilds the desktop packages, and staging refuses a draft whose bytes differ. The single-step manual dispatches described in [`apps/desktop/README.md`](../apps/desktop/README.md) and [`packages/cli/scripts/preview-package.md`](../packages/cli/scripts/preview-package.md) still work.

A release tags its linux/amd64-only `propr/app` and `propr/ui` images `<version>` and `release-<commit SHA>`, not the bare commit SHA. `propr/app:<commit SHA>` and `propr/ui:<commit SHA>` are the two-architecture manifests that Preview Runtime Images publishes. Releases built before this change (v0.9.2 and earlier) pushed an amd64-only image under the bare SHA; Release Rollout stops for them with that reason, because the tag is immutable.

### Last step: check where the release is live

When everything else is done, run:

```bash
npm run release:rollout -- --version <version>          # or: node scripts/verify-release-rollout.mjs --version <version>
npm run release:rollout -- --version <version> --json   # the same results as JSON
```

It needs no credentials and changes nothing: every check is a public read. It prints one line per target, `ok`, `missing` (not there) or `stale` (there, but not this release), followed by what it found:

| Target | `ok` when |
| --- | --- |
| `github-release` | The GitHub release `v<version>` is published (not a draft) and its body starts with the checked-in summary `release-notes/v<version>.md`, read from the tag (or from this checkout when the tag has none). |
| `docker:propr/app`, `docker:propr/ui`, `docker:propr/docs`, `docker:propr/agent` | Docker Hub has the `<version>` tag, and `latest` has the same digest. |
| `npm:propr-cli` | The npm `latest` dist-tag of `propr-cli` is `<version>`. |
| `hosted-ui` | The entry bundle of `https://app.propr.dev/` contains `"<version>"`, the same check the hosted UI deploy runs after deploying (`scripts/lib/hosted-ui-bundle.mjs`). |
| `demo` | `https://demo.propr.dev/api/status` reports `version` `<version>`. |
| `desktop:linux` | A published pre-release tagged `desktop-linux-preview-v<version>-…-all-signed` has the `.deb` and `.rpm` packages for x64 and arm64, `linux-preview.json`, `SHA256SUMS` and `SHA256SUMS.asc`. |
| `desktop:macos` | A published pre-release tagged `desktop-macos-preview-v<version>-…` has the `.dmg` and `.zip` packages for arm64 and x64, `macos-preview.json` and `SHA256SUMS`. |
| `site:whats-new` | `https://propr.dev/whats-new/<version>/` returns 200. |
| `site:download` | The download page, `https://propr.dev/desktop/`, links to the Linux (signed) and macOS desktop pre-releases of `<version>`. |

The command exits 0 only when every target is `ok`. In GitHub Actions it also adds the results as a table to the run summary. Unauthenticated GitHub API reads are limited to 60 an hour per IP address; a rate-limited read shows as `missing` with `HTTP 403 (GitHub API rate limit?)`. To check another destination, add one entry to `TARGETS` in `scripts/verify-release-rollout.mjs`, using one of the check kinds in `scripts/lib/release-rollout/run.mjs`.



ProPR is licensed under the [Apache License 2.0](../LICENSE). Unless you state otherwise, contributions you submit are licensed under the same terms, as set out in section 5 of the license.
