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

## Documentation in the app image

The production `propr/app` image also ships the Markdown sources used by the MCP documentation tools. During the image build, ProPR generates `docs-manifest.json` with the release version, source Git revision, page count, and the ordering from `sidebars.ts`. This keeps the documentation an MCP client reads tied to the same commit as the API it is connected to.

Edit the Markdown and `sidebars.ts` normally in a pull request. No separate MCP publishing step is needed: the next app image build bundles those changes, and agents see them after that release is deployed. Operators may override the bundle with `PROPR_DOCS_DIR`; `list_docs` reports a warning if the mounted docs version does not match the running API.

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
