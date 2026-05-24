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
