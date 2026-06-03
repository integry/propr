# Production Deployment Guide

This guide covers deploying ProPR with the Web UI dashboard in a production environment.

## Prerequisites

- Docker and Docker Compose installed
- A domain name for your deployment
- SSL/TLS certificates (recommended)
- GitHub App configured with proper permissions
- Anthropic API key for Claude, or Mistral API key/config for Vibe agents

## Environment Configuration

1. Copy the example environment files:
```bash
cp .env.example .env
cp packages/api/.env.example packages/api/.env
cp packages/api/client/.env.example packages/api/client/.env
```

2. Update the `.env` file with production values:

### Required Environment Variables

These variables are always required regardless of which coding agent you use.

```bash
# GitHub App Configuration
GH_APP_ID=your-github-app-id
GH_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----"
GH_WEBHOOK_SECRET=your-webhook-secret
GH_CLIENT_ID=your-github-client-id
GH_CLIENT_SECRET=your-github-client-secret

# GitHub OAuth for Dashboard
GH_OAUTH_CLIENT_ID=your-oauth-client-id
GH_OAUTH_CLIENT_SECRET=your-oauth-client-secret
GH_OAUTH_CALLBACK_URL=https://yourdomain.com/api/auth/github/callback

# Security
SESSION_SECRET=generate-a-strong-secret-here
ALLOWED_ORGS=your-org1,your-org2

# Dashboard URLs
FRONTEND_URL=https://yourdomain.com
FRONTEND_API_URL=https://yourdomain.com
FRONTEND_APP_URL=https://yourdomain.com

# Redis (usually no changes needed)
REDIS_HOST=redis
REDIS_PORT=6379

# Logging
LOG_LEVEL=info
```

### Agent Credentials (set only the agents you use)

Each agent type requires its own credentials. You only need to configure the
agents you plan to use — at least one is required.

```bash
# Claude agent (set if using Claude)
ANTHROPIC_API_KEY=your-anthropic-api-key

# Mistral Vibe agent (set if using Vibe)
# Option A: API-key auth (simplest)
MISTRAL_API_KEY=your-mistral-api-key
# Option B: config-file auth (set HOST_VIBE_DIR to the host path of your
# .vibe credential directory instead of / in addition to MISTRAL_API_KEY)
# HOST_VIBE_DIR=/home/propr/.vibe

# Required whenever Vibe agents are enabled (MISTRAL_API_KEY or HOST_VIBE_DIR
# is set). The prompt cache directory must be host-visible so spawned agent
# containers can bind-mount prompt files. Both vars should point to the same
# host directory. Create it before starting:
#   mkdir -p /tmp/propr-vibe-prompts
VIBE_PROMPT_CACHE_DIR=/tmp/propr-vibe-prompts
HOST_VIBE_PROMPT_CACHE_DIR=/tmp/propr-vibe-prompts
```

## Building Agent Images

Each coding agent runs in its own Docker image. The images for Claude, Codex,
Gemini, and Vibe are built from their respective Dockerfiles at the project root.

```bash
# Build all agent images (including propr/agent-vibe)
scripts/build-images.sh

# Or build the Vibe agent image individually
docker build -f Dockerfile.vibe -t propr/agent-vibe:latest .
```

The Vibe image pins a specific CLI version via the `CLI_VERSION` build arg in
`Dockerfile.vibe`. To upgrade the Vibe CLI, update `CLI_VERSION` and rebuild.

## Deployment Steps

> **Launcher vs Compose:** The production launcher (`docker/launcher/`) is the
> recommended deployment method. It conditionally mounts only configured agent
> credential directories and validates Vibe prompt cache paths at startup.
> The `docker-compose.yml` in the project root is intended for local
> development and mounts all agent directories unconditionally.

### 1. Build and Start Services

#### Option A: Launcher (Recommended)

The production launcher validates bind mount paths and conditionally mounts
only configured agent credential directories at startup. It also enforces
that `HOST_VIBE_PROMPT_CACHE_DIR` is set when Vibe agents are enabled.

```bash
# Build the launcher image
docker build -t propr/launcher:latest -f docker/launcher/Dockerfile .

# Run the launcher (adjust host paths to match your environment)
docker run --rm -it \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$PWD/.env:/app/.env:ro" \
  -e PROPR_ENV_FILE="$PWD/.env" \
  -e PROPR_DATA_DIR="$PWD/data" \
  -e PROPR_LOGS_DIR="$PWD/logs" \
  -e PROPR_REPOS_DIR="$PWD/repos" \
  -e HOST_CLAUDE_DIR="$HOME/.claude" \
  propr/launcher:latest
```

#### Option B: Docker Compose

```bash
# Build and start all services (production compose)
docker-compose -f docker-compose.prod.yml up -d

# Check service status
docker-compose -f docker-compose.prod.yml ps

# View logs
docker-compose -f docker-compose.prod.yml logs -f
```

> **Note:** Use `docker-compose.prod.yml` for production deployments.
> The root `docker-compose.yml` is intended for development and mounts all
> agent credential directories unconditionally, which may expose dev defaults.
>
> For Vibe config-file auth (instead of API key auth), uncomment the
> `HOST_VIBE_DIR` volume mount in `docker-compose.prod.yml` and set the
> variable in your `.env`. For full multi-agent development environments,
> use the root `docker-compose.yml` or the launcher (Option A).

### 2. SSL/TLS Configuration (Recommended)

For production, you should use HTTPS. Here's an example using nginx as a reverse proxy:

```nginx
server {
    listen 443 ssl http2;
    server_name yourdomain.com;

    ssl_certificate /path/to/ssl/cert.pem;
    ssl_certificate_key /path/to/ssl/key.pem;

    location / {
        proxy_pass http://localhost:80;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

server {
    listen 80;
    server_name yourdomain.com;
    return 301 https://$server_name$request_uri;
}
```

### 3. GitHub App Configuration

Update your GitHub App settings:

1. **Homepage URL**: `https://yourdomain.com`
2. **Webhook URL**: `https://yourdomain.com/webhook`
3. **Callback URL**: `https://yourdomain.com/api/auth/github/callback`

### 4. Monitoring

Monitor your deployment:

```bash
# Check system health via API
curl https://yourdomain.com/api/status

# If using the launcher (Option A):
docker logs -f propr-worker
docker logs -f propr-daemon

# If using Docker Compose (Option B):
docker-compose exec redis redis-cli INFO
docker-compose logs -f worker
docker-compose logs -f daemon
```

## Maintenance

### Updating the Application

```bash
# Pull latest changes
git pull

# If using the launcher: rebuild the launcher image and restart
docker build -t propr/launcher:latest -f docker/launcher/Dockerfile .
# Then re-run your launcher command (see Option A above)

# If using Docker Compose: rebuild and restart
docker-compose build
docker-compose up -d
```

### Backup

Important data to backup:
- Redis data: `redis-data` volume
- Repository data: `./repos` directory
- Logs: `./logs` directory

```bash
# Backup Redis data (launcher)
docker exec propr-redis redis-cli BGSAVE
# Backup Redis data (compose)
docker-compose exec redis redis-cli BGSAVE

# Create backup archive
tar -czf propr-backup-$(date +%Y%m%d).tar.gz \
  ./repos \
  ./logs \
  docker-volume-backup-redis-data
```

### Scaling

To handle more load, you can scale the worker service (Docker Compose only):

```bash
docker-compose up -d --scale worker=3
```

## Troubleshooting

### Common Issues

1. **Dashboard shows "Unauthorized"**
   - Check GitHub OAuth configuration
   - Verify SESSION_SECRET is set
   - Check FRONTEND_URL matches your domain

2. **Worker not processing issues**
   - Check Redis connectivity
   - Verify GitHub App permissions
   - Check worker logs for errors

3. **Metrics not updating**
   - Ensure Redis is running
   - Check worker is processing jobs
   - Verify metrics keys in Redis

### Debug Commands

```bash
# Check Redis keys (use "docker exec propr-redis" for launcher deployments)
docker-compose exec redis redis-cli KEYS '*'

# Monitor Redis activity
docker-compose exec redis redis-cli MONITOR

# Check queue status
docker-compose exec redis redis-cli LLEN github-issue-processor

# View recent activities
docker-compose exec redis redis-cli LRANGE system:activity:log 0 10
```

## Security Recommendations

1. **Use strong secrets** for SESSION_SECRET
2. **Enable HTTPS** for all production deployments — auth redirects require HTTPS for all non-localhost targets by default. HTTP is only permitted for `localhost`, `127.0.0.1`, and `::1` to support local development. Internal or preview deployments that use HTTP hostnames can set `AUTH_ALLOW_HTTP_REDIRECT=true` to allow HTTP redirects to allowed hosts.
3. **Restrict access** using ALLOWED_ORGS
4. **Regular updates** of Docker images and dependencies
5. **Monitor logs** for suspicious activity
6. **Backup regularly** and test restore procedures

## Performance Tuning

Adjust these settings based on your needs:

- `WORKER_CONCURRENCY`: Number of jobs processed simultaneously (default: 5)
- `POLL_INTERVAL`: How often daemon checks for new issues (default: 60000ms)
- Redis memory limits in docker-compose configuration
- Worker container CPU/memory limits
