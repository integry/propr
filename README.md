# ProPR

**An AI engineering platform for planning, building, reviewing, and shipping changes through GitHub.** Self-hosted.

ProPR monitors GitHub issues and pull requests, runs your choice of AI coding agents in isolated containers, and drives a complete workflow from a labeled issue to an opened pull request — with a Web UI for configuration and monitoring and a CLI that doubles as the local control plane.

📖 **Full documentation: [docs.propr.dev](https://docs.propr.dev/docs/intro)**

---

## Modular, not all-or-nothing

ProPR is a set of stages you can adopt independently — use one or all:

- **Plan** — turn an issue or idea into a reviewable implementation plan (Planner Studio)
- **Implement** — label an issue and let an agent open a PR for it
- **Review & fix** — drive existing PRs with slash commands (`/review`, `/fix`, `/ultrafix`, model routing)
- **Operate** — monitor tasks, costs, logs, and agent capacity from the Web UI

## Highlights

- **Multi-agent**: Claude Code, OpenAI Codex, Google Antigravity, OpenCode, and Mistral Vibe — all first-class, selectable per issue
- **Label-based model routing**: pick the agent/model per issue with `llm-<agent>-<model>` labels; multiple labels fan out into parallel jobs
- **Web UI dashboard**: configure repositories, branches, labels, agents, and defaults; watch tasks, logs, commits, and cost in real time
- **CLI control plane**: scaffold, verify, start, and stop the local Docker stack — and drive plans, issues, tasks, and repos against the backend
- **GitHub PR automation**: slash commands, automatic state labels, and PR follow-ups
- **Deterministic git workflow**: isolated worktrees, model-specific branches, and a strict setup → implement → finalize pipeline
- **Production-ready**: Docker-isolated agent execution, Redis-backed job state with correlation IDs, retries with backoff, and Agent Tank capacity/rate-limit tracking

## Quick start (recommended: CLI)

The CLI is the simplest way to run a local stack. It requires **Docker** and **Node.js 22+**.

```bash
npm install -g propr-cli

propr init stack    # scaffold .env, detect agent credentials
propr check         # verify Docker, images, agents, and GitHub auth
propr start         # boot the stack with a live dashboard
```

Then open the Web UI at **http://localhost:5173** and add a repository and an agent (`propr repo add`, `propr agent add`, or via the UI).

See the [Local Setup tutorial](https://docs.propr.dev/docs/tutorials/setup-local) for the full walkthrough, [Server Setup](https://docs.propr.dev/docs/tutorials/setup-server) for shared/production hosts, and [Secure VPS Deployment](https://docs.propr.dev/docs/tutorials/setup-vps) for a hardened install.

> **No Node.js on the host?** The stack can also be launched from the prebuilt `propr/launcher` image with a single `docker run`. See [Setup](https://docs.propr.dev/docs/tutorials/setup).

## Supported agents

| Agent | Type | Provider | Execution image |
|---|---|---|---|
| Claude Code | `claude` | Anthropic | `propr/agent-claude` |
| Codex | `codex` | OpenAI | `propr/agent-codex` |
| Antigravity | `antigravity` | Google (multi-model) | `propr/agent-antigravity` |
| OpenCode | `opencode` | OpenCode (multi-provider) | `propr/agent-opencode` |
| Mistral Vibe | `vibe` | Mistral | `propr/agent-vibe` |

You supply your own provider credentials. The full model catalog, per-agent credential setup, and label formats live in [Agents & Models](https://docs.propr.dev/docs/features/agents-and-models).

### Selecting a model with labels

Add an `llm-<agent>-<model>` label to an issue to choose who processes it:

- `llm-claude-opus48` — Claude Opus 4.8
- `llm-codex-gpt54` — Codex GPT-5.4
- `llm-opencode-minimax-m3-free` — OpenCode MiniMax M3 Free
- `llm-antigravity-pro-high` — Antigravity Gemini 3.1 Pro High
- `llm-antigravity-opus46-thinking` — Antigravity Claude Opus 4.6 Thinking

Multiple model labels on one issue create one independent job (and branch) per model. Add a `base-<branch>` label to target a non-default branch.

## How it works

Each labeled issue runs through a deterministic three-phase pipeline:

1. **Pre-agent setup** — clone/update the repo, create an isolated worktree on a model-specific branch, and push it to GitHub.
2. **AI implementation** — run the selected agent in a sandboxed container with implementation-only prompts and full issue + comment context.
3. **Post-agent finalization** — commit changes, push, and open a pull request linked to the issue (`Closes #123`), then manage state labels.

Branches follow `<issueId>/<model>-<sanitized-title>-<YYYYMMDD-HHMM>-<random>`, e.g. `349/claude-opus48-feat-implement-onboarding-20260529-1506-3he`.

State labels are derived from the trigger label, so an issue labeled `AI` moves through `AI-processing` → `AI-waiting` → `AI-done` / `AI-failed-*`, while a `propr`-labeled issue uses the `propr-*` set. Configure trigger labels in the UI or via `PRIMARY_PROCESSING_LABELS`.

## Documentation

| Topic | Link |
|---|---|
| Introduction | https://docs.propr.dev/docs/intro |
| Feature overview | https://docs.propr.dev/docs/features/overview |
| Local setup (recommended) | https://docs.propr.dev/docs/tutorials/setup-local |
| Server setup | https://docs.propr.dev/docs/tutorials/setup-server |
| Secure VPS deployment | https://docs.propr.dev/docs/tutorials/setup-vps |
| Daily usage | https://docs.propr.dev/docs/tutorials/usage |
| Planner Studio | https://docs.propr.dev/docs/tutorials/planner-studio |
| CLI reference | https://docs.propr.dev/docs/features/propr-cli |
| Agents & models | https://docs.propr.dev/docs/features/agents-and-models |
| Web UI guide | https://docs.propr.dev/docs/features/web-ui |
| PR slash commands | https://docs.propr.dev/docs/features/pr-commands |
| GitHub authentication | https://docs.propr.dev/docs/operations/github-auth |
| Deployment | https://docs.propr.dev/docs/operations/deployment |
| Architecture | https://docs.propr.dev/docs/architecture/overview |

The docs site also ships inside the stack — run `propr docs` to open the bundled copy.

## Configuration

Bootstrap credentials and infrastructure paths are set once via a `.env` file (GitHub App ID/key, OAuth, session secret, storage paths). Everything operational — repositories, branches, labels, agents, supported models, defaults — is managed in the Web UI or via the CLI.

Start from [`.env.example`](.env.example) and see [GitHub authentication](https://docs.propr.dev/docs/operations/github-auth) and [Deployment](https://docs.propr.dev/docs/operations/deployment) for the full reference.

## Prebuilt images

ProPR ships as a set of prebuilt images orchestrated by the `propr/launcher` umbrella image (mirrored to `ghcr.io/proprdev/*`):

| Image | Contents |
|---|---|
| `propr/launcher` | Orchestrator that spawns the stack |
| `propr/app` | Server — daemon / workers / API (role selected at launch) |
| `propr/ui` | Web UI static bundle |
| `propr/docs` | Docusaurus documentation site (optional) |
| `propr/agent-base` | Shared base for agent images |
| `propr/agent-{claude,codex,antigravity,opencode,vibe}` | Per-agent execution containers |

End users must supply their own provider API credentials and accept those providers' terms. Bundled third-party attributions are preserved at `/usr/share/licenses/propr/` in each image; offline copies are in [`NOTICE`](NOTICE) and [`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md).

## Developing from source

A source checkout is only needed to modify ProPR itself (requires Node.js, Redis, Git, and Docker).

```bash
npm ci                 # install workspace dependencies
npm run compose:up     # build and run the full stack from source
npm test               # run the test suite
```

Common workspace scripts:

```bash
npm run daemon:dev     # issue-detection daemon (debug logging)
npm run worker:dev     # job worker (debug logging)
npm run dashboard:dev  # dashboard API
npm run images:build   # build all Docker images locally
npm run images:smoke   # smoke-test locally built images
```

See the [source setup tutorial](https://docs.propr.dev/docs/tutorials/setup-source) for the development flow and the [architecture docs](https://docs.propr.dev/docs/architecture/overview) for how the pieces fit together.

### Project structure

```
propr/
├── src/            # Daemon, workers, jobs, polling, GitHub handling
├── packages/
│   ├── core/       # Git/worktree management, agents, queue, config, DB migrations
│   ├── api/        # Dashboard REST API, webhooks, authentication
│   ├── cli/        # The `propr` command (published to npm as propr-cli)
│   └── shared/     # Shared model catalog and types
├── propr-ui/       # Web UI (React + Vite)
├── docs/           # Docusaurus documentation site
├── docker/         # Launcher and agent-base images
├── scripts/        # Agent entrypoints, build/compose/release helpers
└── docker-compose*.yml
```

### Releasing

Docker image releases run via the **Docker Images** GitHub Actions workflow. Bump the version, then tag the merged commit (the workflow verifies the tag matches `package.json`):

```bash
git tag v0.8.4
git push origin v0.8.4
```

The `propr-cli` npm package is published separately with `npm run cli:publish` (build + publish the standalone, unscoped package).

## Contributing

Contributions are welcome. Please follow existing code patterns, keep tests passing, update docs alongside code, and use the structured logger for output. See [`CHANGELOG.md`](CHANGELOG.md) for release history.
