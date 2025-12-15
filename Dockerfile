FROM node:20-slim

WORKDIR /usr/src/app

# Install git, sudo, and docker client
# Git is required for simple-git operations in the application
# Sudo is required for changing file ownership in worktrees
RUN apt-get update && apt-get install -y \
    git \
    sudo \
    docker.io \
    && rm -rf /var/lib/apt/lists/*

# Copy package files (including workspace packages)
COPY package*.json ./
COPY packages/shared/package*.json ./packages/shared/
COPY packages/core/package*.json ./packages/core/
COPY packages/dashboard/package*.json ./packages/dashboard/

RUN npm install

COPY . .

# Build shared package first (required for @gitfix/shared imports)
RUN cd packages/shared && npm run build

# Build core package (required for @gitfix/core imports)
RUN cd packages/core && npm run build

# Build TypeScript to JavaScript
RUN npm run build

# The command will be specified in docker-compose.yml