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

COPY package*.json ./
RUN npm install

COPY . .

# Build TypeScript to JavaScript
RUN npm run build

# The command will be specified in docker-compose.yml