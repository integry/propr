FROM node:22-slim

WORKDIR /usr/src/app

ARG GH_VERSION=2.99.0
ARG TARGETARCH

# Install git, sudo, Docker tooling, and build tools for native modules
# (better-sqlite3). Debian's essential bsdutils package already provides
# script(1), used as the browser agent-login PTY bridge.
# Git is required for simple-git operations in the application
# Sudo is required for changing file ownership in worktrees
# python3, make, g++ are required for building native Node.js modules like better-sqlite3
RUN apt-get update && apt-get install -y \
    git \
    sudo \
    docker.io \
    curl \
    python3 \
    make \
    g++ \
    && gh_arch="${TARGETARCH:-amd64}" \
    && case "$gh_arch" in amd64|arm64) ;; *) echo "Unsupported GitHub CLI architecture: $gh_arch" >&2; exit 1 ;; esac \
    && gh_archive="gh_${GH_VERSION}_linux_${gh_arch}.tar.gz" \
    && curl -fsSLO "https://github.com/cli/cli/releases/download/v${GH_VERSION}/${gh_archive}" \
    && curl -fsSLO "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_checksums.txt" \
    && grep "  ${gh_archive}$" "gh_${GH_VERSION}_checksums.txt" | sha256sum -c - \
    && tar -xzf "$gh_archive" \
    && install -m 0755 "gh_${GH_VERSION}_linux_${gh_arch}/bin/gh" /usr/local/bin/gh \
    && rm -rf "$gh_archive" "gh_${GH_VERSION}_checksums.txt" "gh_${GH_VERSION}_linux_${gh_arch}" \
    && gh --version \
    && rm -rf /var/lib/apt/lists/*

# Copy package files (including workspace packages)
COPY package*.json ./
COPY packages/shared/package*.json ./packages/shared/
COPY packages/local-setup/package*.json ./packages/local-setup/
COPY packages/core/package*.json ./packages/core/
COPY packages/api/package*.json ./packages/api/

RUN npm install

COPY . .

# Build shared package first (required for @propr/shared imports)
RUN cd packages/shared && npm run build

# Build Node-local shared storage helpers used by the API and CLI.
RUN cd packages/local-setup && npm run build

# Build core package (required for @propr/core imports)
RUN cd packages/core && npm run build

# Build TypeScript to JavaScript
RUN npm run build

# The command will be specified in docker-compose.yml
