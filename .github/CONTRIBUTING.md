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

A release goes through these steps, in order:

1. **Metadata pull request.** Bump the versions, add the `CHANGELOG.md` entry and the `release-notes/v<version>.md` summary ([below](#the-preparation-pull-request)). Before merging, `EXPECTED_VERSION=<version> RELEASE_TAG=v<version> RELEASE_CANDIDATE=true npm run release:verify` checks that the release metadata is consistent.
2. **Tag.** Push the `v<version>` tag on the merged commit.
3. **Automatic publication.** The tag push runs the **Docker Images** workflow (`.github/workflows/docker-images.yml`), which validates the tag, publishes the images and the npm package, creates the GitHub release with the release summary on top and [deploys the hosted UI](https://docs.propr.dev/docs/operations/hosted-ui-release).
4. **Release Rollout.** When Docker Images succeeds, `release-rollout.yml` starts on its own and builds the runtime images, the desktop preview pre-releases and the preview CLI bundle. Approve each protected environment as the run reaches it (below).
5. **Follow-up issues.** The last Release Rollout job writes the follow-ups outside this repository: the ProPR Hosted repin, the site's release date and desktop downloads, and the demo move (below). Work through the issues it opened, or file the texts in its run summary by hand.
6. **Final check.** `npm run release:rollout -- --version <version>` says where the release is live ([last step](#last-step-check-where-the-release-is-live)).

### The preparation pull request

The pull request that prepares the release metadata:

1. Bumps the version in the root `package.json`, every release-versioned `@propr` workspace, the desktop package, the matching `package-lock.json` records and internal dependency ranges, `PROPR_VERSION` and the launcher manifest, then regenerates the Fly dashboard launch `fly.toml` with `npx tsx packages/cli/scripts/render-fly-launch-toml.ts` so it pins `propr/app:<version>`. Independently versioned packages keep their own versions.
2. Renames `## [Unreleased]` in `CHANGELOG.md` to `## [<version>] - <date>`, adds a new empty `## [Unreleased]` above it and updates the comparison links.
3. Writes the release summary, `release-notes/v<version>.md` (see below).
4. Passes `EXPECTED_VERSION=<version> RELEASE_TAG=v<version> RELEASE_CANDIDATE=true npm run release:verify`.

### Release summary

`release-notes/v<version>.md` is the top of the GitHub release. The release job reads it from the release tag and creates the release with `gh release create --notes-file … --generate-notes`, so the summary comes first and GitHub's generated "What's Changed" list of pull requests follows it. [`release-notes/v0.9.2.md`](../release-notes/v0.9.2.md) is an example.

Write it from the version's `CHANGELOG.md` section, for someone deciding whether and how to upgrade. Keep it to roughly 30–50 lines: it is a summary, not a second changelog. It has two sections:

- `## Highlights`: what the release means for a user, grouped by area (for example **Pull requests**, **Automations**, **Agents and models**, **Fixes and security**), in plain language. Do not copy pull request titles. Start with one sentence about the release that links to the changelog at the tag (`https://github.com/integry/propr/blob/v<version>/CHANGELOG.md`) and to the site's what's-new page (`https://propr.dev/whats-new/<version>/`).
- `## Upgrade notes`: behaviour changes, migrations, deprecations and retirements, and anything to do before or after upgrading. Write `None.` when there are none.

`npm run release:verify` fails in release-candidate mode (every pull request's **Validate Changes**) and on the release tag when the current version's file is missing or empty, lacks either section or has an empty one, does not have both links, or still contains a placeholder (`TODO`, `TBD`, `FIXME`, `XXX`, an HTML comment, an `<angle-bracket>` or `{{ }}` slot, or filler text). A release whose GitHub release already exists, for example a re-run, only gets its assets uploaded and keeps its text.

### Desktop previews and the preview CLI bundle

When Docker Images succeeds for the tag push, the **Release Rollout** workflow (`.github/workflows/release-rollout.yml`) starts on its own. To start it by hand, for example after a manual Docker Images run or to re-run a tag:

```bash
gh workflow run release-rollout.yml --ref main -f release_tag=v<version>
```

It uses the tag commit as the source revision and runs the steps that used to be separate dispatches, in order, passing each output (image digests, run ids) to the next:

1. Preview Runtime Images `publish-agent`, then `publish` (the `linux/amd64` managed agent, then the two-architecture app and UI images).
2. In parallel: Desktop Linux Preview Release `stage-draft`, then Desktop Linux Authenticated Preview `sign-draft` and `publish-draft`; the Desktop macOS Preview Release; and the Preview CLI Bundle for ProPR Hosted.

Each step calls the existing workflow, so it waits at the same protected environments for the same reviewers: `desktop-linux-preview-runtime-publication`, `desktop-linux-rpm-signing`, `desktop-linux-preview-publication` and `desktop-macos-preview-publication`. The run summary starts with the plan, then has one line per step and ends with the follow-ups (below).

Re-running for a tag is safe. The first job finds the runtime images and published preview pre-releases that already exist for the tag commit, skips those steps and passes their digests on. To resume a run that stopped part-way (a rejected approval, a flaky runner), re-run its failed jobs rather than starting a new run: a new run rebuilds the desktop packages, and staging refuses a draft whose bytes differ. The single-step manual dispatches described in [`apps/desktop/README.md`](../apps/desktop/README.md) and [`packages/cli/scripts/preview-package.md`](../packages/cli/scripts/preview-package.md) still work.

A release tags its linux/amd64-only `propr/app` and `propr/ui` images `<version>` and `release-<commit SHA>`, not the bare commit SHA. `propr/app:<commit SHA>` and `propr/ui:<commit SHA>` are the two-architecture manifests that Preview Runtime Images publishes. Releases built before this change (v0.9.2 and earlier) pushed an amd64-only image under the bare SHA; Release Rollout stops for them with that reason, because the tag is immutable.

### Follow-ups outside this repository

After the desktop chain, the **Release follow-ups** job of Release Rollout (`scripts/release-followups.mjs`) writes one follow-up per repository from the chain's outputs and adds them to the run summary:

| Repository | Issue | Contents | Written when |
| --- | --- | --- | --- |
| `integry/propr-fleet` | Repin ProPR Hosted to ProPR `<version>` | The Release Rollout run id, the preview CLI bundle artifact name and id, the tarball name and sha256, the CLI version, the tag commit and the three digest-pinned runtime images, with the repin steps for `ansible/playbooks/group_vars/all.yml`. | The preview CLI bundle succeeded. |
| `integry/propr-site` | Site: publication date and desktop downloads for ProPR `<version>` | The GitHub release's `published_at` for `release-site-src/src/data/follow.ts`, and the signed Linux and macOS desktop pre-release tags for `release-site-src/src/data/releases.ts`. | The GitHub release is published and both desktop pre-releases are published (by this run or an earlier one). |
| `integry/propr-deploy` | Move demo.propr.dev to ProPR `<version>` | The `DEMO_API_IMAGE` / `DEMO_UI_IMAGE` pins in the host-only `deploy.env` and `./scripts/deploy.sh demo`. | `https://demo.propr.dev/api/status` does not report `<version>` yet. |

A follow-up that is not ready says why in the summary; re-run the follow-ups job (**Re-run job** in the run) once the missing step is done.

Two optional repository secrets turn the follow-ups into actions:

- **`RELEASE_FOLLOWUP_ISSUES_TOKEN`**: a fine-grained personal access token (or GitHub App token) with only **Issues: read and write** on `integry/propr-fleet`, `integry/propr-site` and `integry/propr-deploy`. With it, the job opens each ready follow-up with `gh issue create`, skipping one whose exact title already exists (open or closed), and lists the issue links in the summary. Without it the job still succeeds; the summary, and the job log, carry each issue's exact title and body to file by hand.
- **`DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY`**: the deploy-on-release secrets from `DEPLOYMENT.md` in `integry/propr-deploy`. With all three, the job runs the documented SSH deploy (`cd /root/propr-deploy && ./scripts/deploy.sh all`) before writing the follow-ups, and the demo issue is written only if the demo still does not report the release. A failed deploy is a warning, not a failed run. The deploy user must accept SSH from GitHub-hosted runners.

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

The command exits 0 only when every target is `ok`. In GitHub Actions it also adds the results as a table to the run summary. The last Release Rollout job, **Check where the release is live**, runs it for the planned version after the follow-ups, also when an earlier step failed, so every run summary ends with this table; a target that is not yet `ok` (the demo refresh and the site follow-ups usually land later) is a warning there, not a failed run. Run the command again once the follow-ups are done. Unauthenticated GitHub API reads are limited to 60 an hour per IP address; a rate-limited read shows as `missing` with `HTTP 403 (GitHub API rate limit?)`. To check another destination, add one entry to `TARGETS` in `scripts/verify-release-rollout.mjs`, using one of the check kinds in `scripts/lib/release-rollout/run.mjs`.

## License

ProPR is licensed under the [Apache License 2.0](../LICENSE). Unless you state otherwise, contributions you submit are licensed under the same terms, as set out in section 5 of the license.
