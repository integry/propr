# Website

This website is built using [Docusaurus](https://docusaurus.io/), a modern static website generator.

## Requirements

- Node.js 20+
- npm

## Installation

```bash
cd docs
npm ci
```

Run the docs commands from the `docs/` directory. The Docusaurus site has its own lockfile there, so docs-only work does not require the repository-root install.

## Local Development

```bash
cd docs
npm run start
```

This command starts a local development server and opens up a browser window. Most changes are reflected live without having to restart the server.

## Build

```bash
cd docs
npm run build
```

This command generates static content into the `build` directory and can be served using any static contents hosting service.

The `propr/docs` image (`docs/Dockerfile`) serves that directory with a pinned `serve` and `docs/serve.json`. Docusaurus writes a real `index.html` for every route, so the server must not run in single-page (`-s`) mode: that answers every path, including unknown ones, with the homepage. To check the image's exact server command against a fresh build, run `npm run docs:check-serving` from the repository root. It checks that each "For your workflow" link and a set of representative routes return their own article HTML, title, canonical URL and heading anchor. It also checks that `sitemap.xml` and the assets are served and that unknown paths return the 404 page with status 404.

## Documentation in the app image

The production `propr/app` image also ships the Markdown sources used by the MCP documentation tools. During the image build, ProPR generates `docs-manifest.json` with the release version, source Git revision, page count, and the ordering from `sidebars.ts`. This keeps the documentation an MCP client reads tied to the same commit as the API it is connected to.

Edit the Markdown and `sidebars.ts` normally in a pull request. No separate MCP publishing step is needed: the next app image build bundles those changes, and agents see them after that release is deployed. Operators may override the bundle with `PROPR_DOCS_DIR`; `list_docs` reports a warning if the mounted docs version does not match the running API.

## Assistant knowledge (solv.chat)

The solv.chat assistant on propr.dev answers from the public documentation. The workflow `.github/workflows/solv-docs-push.yml` pushes it on every push to `main` that changes `docs/docs/**`, `README.md`, `CHANGELOG.md` or the workflow itself. It never runs on pull requests or forks.

**What is pushed:**

- every page in `docs/docs`, linked to its public URL under `https://docs.propr.dev/docs`. For example, `intro.md` maps to `/docs/intro`, `features/goals.md` to `/docs/features/goals`, and an `index.md` maps to its folder's URL.
- `README.md` and `CHANGELOG.md`, linked to their pages on GitHub on the default branch.

Everything else under `docs/` is never pushed, because it is outside the content folder: `library/`, `operations/`, `contracts/`, `benchmarks/` and the engineering notes at the top level.

**What is left out of `docs/docs`:**

- files and folders whose names start with `_`
- pages with `draft: true` or `unlisted: true` in their front matter
- these internal pages, which are not in the sidebar:
  - `architecture/instance-storage-v1.md`
  - `operations/desktop-live-github-smoke.md`
  - `operations/desktop-native-shutdown-investigation.md`
  - `operations/linux-validation-candidate.md`
  - `operations/macos-local-setup-acceptance.md`

If you add another internal-only page, add it to the `exclude` list in the workflow and to the list above.

Every push uses the source name `propr-docs` with prune turned on. A page deleted from the docs is also removed from the assistant, and documents pushed under any other source name are not touched.

**Settings.** Under **Settings → Secrets and variables → Actions**, set:

- the variable `SOLV_ENDPOINT` to the solv.chat Worker's base URL
- the variable `SOLV_ASSISTANT_ID` to the assistant id (`ast_…`)
- the secret `SOLV_INGEST_KEY` to the assistant's ingest key

Do not commit any of these values. Until all three are set, the job succeeds with a notice that names what is missing, and it pushes nothing.

**Running it by hand.** Go to **Actions → Push Docs to solv.chat → Run workflow** and pick `main`. A run started from any other branch is skipped. To preview a push without sending anything, run the solv CLI (Node 24) from the repository root. Build it from a checkout of `integry/solv.chat` at `v0.1.6` (`npm ci && npm run build -w @solvchat/cli`), then run:

```bash
node <solv.chat>/packages/cli/bin/solv.js push --dry-run \
  --endpoint https://unused.invalid --assistant ast_unused \
  --base-url https://docs.propr.dev/docs --source propr-docs --prune \
  --exclude '**/_*' --exclude architecture/instance-storage-v1.md \
  --exclude operations/desktop-live-github-smoke.md \
  --exclude operations/desktop-native-shutdown-investigation.md \
  --exclude operations/linux-validation-candidate.md \
  --exclude operations/macos-local-setup-acceptance.md \
  --file README.md=https://github.com/integry/propr/blob/main/README.md \
  --file CHANGELOG.md=https://github.com/integry/propr/blob/main/CHANGELOG.md \
  -- docs/docs
```

The dry run lists each document's ID and URL, and needs no ingest key.

## Deployment

Using SSH:

```bash
cd docs
USE_SSH=true npm run deploy
```

Not using SSH:

```bash
cd docs
GIT_USER=<Your GitHub username> npm run deploy
```

If you are using GitHub pages for hosting, this command is a convenient way to build the website and push to the `gh-pages` branch.
