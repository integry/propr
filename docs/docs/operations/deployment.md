# Production Deployment Guide

This guide covers deploying ProPR with the Web UI dashboard in a production environment.

## Prerequisites

- Docker and Docker Compose installed
- A domain name for your deployment
- SSL/TLS certificates (recommended)
- GitHub App configured with proper permissions
- Provider credentials for the agents you plan to enable
- Persistent storage for Redis and the shared SQLite application database used by the default Compose deployment

## Environment Configuration

1. Copy the example environment files:
```bash
cp .env.example .env
cp packages/api/.env.example packages/api/.env
cp propr-ui/.env.example propr-ui/.env
```

2. Update the `.env` file with production values.

Important:

- The production compose example in this repository is a minimal Claude-first deployment and wires `ANTHROPIC_API_KEY` by default.
- If you enable Codex or Gemini agents in the AI Agents UI, you must also mount their credential directories into the `api` and `worker` containers and make sure the enabled agent configs point at those mounted paths.
- The default production deployment stores application state in Redis plus a shared SQLite database file mounted into the `api`, `daemon`, and `worker` containers.

### Core Environment Variables

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

# Claude API for the default compose example
ANTHROPIC_API_KEY=your-anthropic-api-key

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

# Shared SQLite database file used by api, daemon, and worker
DB_FILENAME=/app/data/propr.sqlite

# Logging
LOG_LEVEL=info
```

## Stateful Services

The default `docker-compose.prod.yml` deployment has two stateful stores:

- Redis for queues, transient state, and cached metrics
- A shared SQLite database file at `/app/data/propr.sqlite` for persistent application data such as repository settings, planner data, task state, and historical metrics

The `api`, `daemon`, and `worker` services all mount the same `propr-sqlite-data` volume so they see the same application database. If you replace the default deployment topology, preserve that shared persistent storage behavior.

### Additional Agent Setup For Codex And Gemini

The core `.env` file is not enough for a multi-agent production deployment. If you enable Codex or Gemini, complete all of the following before you send production work to those agents:

1. Add enabled agent entries in the AI Agents UI with the correct `dockerImage`, `configPath`, supported models, and default model.
2. Make the agent credential directories available inside both the `api` and `worker` containers at the same absolute path the agent configuration uses.
3. Ensure the corresponding agent images are available on the Docker host, such as `codex-cli:latest` and `gemini-cli:latest`.

Typical host-mounted config paths:

- Claude: `~/.claude`
- Codex: `~/.codex`
- Gemini: `~/.gemini`

Example compose override for Codex and Gemini credentials:

```yaml
services:
  api:
    volumes:
      - /srv/propr/agent-creds/codex:/root/.codex
      - /srv/propr/agent-creds/gemini:/root/.gemini
  worker:
    volumes:
      - /srv/propr/agent-creds/codex:/root/.codex
      - /srv/propr/agent-creds/gemini:/root/.gemini
```

Then configure the corresponding agents in the UI to use `/root/.codex` and `/root/.gemini` as their `configPath` values, or keep the defaults if you mount them at the default paths. If you use the launcher-based deployment flow instead of Compose, pass `HOST_CODEX_DIR` and `HOST_GEMINI_DIR` so those credential directories are mounted through the launcher automatically.

## Deployment Steps

### 1. Build and Start Services

```bash
# Build and start all services
docker-compose -f docker-compose.prod.yml up -d

# Check service status
docker-compose -f docker-compose.prod.yml ps

# View logs
docker-compose -f docker-compose.prod.yml logs -f
```

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

# Monitor Redis
docker-compose -f docker-compose.prod.yml exec redis redis-cli INFO

# Check worker logs
docker-compose -f docker-compose.prod.yml logs -f worker

# Check daemon logs
docker-compose -f docker-compose.prod.yml logs -f daemon
```

## Maintenance

### Updating the Application

```bash
# Pull latest changes
git pull

# Rebuild and restart services
docker-compose -f docker-compose.prod.yml build
docker-compose -f docker-compose.prod.yml up -d
```

### Backup

Important data to backup:
- SQLite application data: the `propr-sqlite-data` volume
- Redis data: the `propr-redis-data` volume
- Repository data: `./repos` directory
- Logs: `./logs` directory
- The environment or secret-management source that provides your production `.env` values

Run backups during a maintenance window. The example below records which of the stateful services were already running, stops the application writers, forces Redis to persist its in-memory state, and uses a subshell `trap` so only that original running set is started again when the backup subshell exits.

```bash
(
  set -euo pipefail

  backup_date="$(date +%Y%m%d)"
  compose_file="docker-compose.prod.yml"

  mapfile -t running_services < <(
    docker-compose -f "$compose_file" ps --status running --services | grep -E '^(api|daemon|worker|redis)$' || true
  )

  restart_services() {
    if [ "${#running_services[@]}" -gt 0 ]; then
      docker-compose -f "$compose_file" start "${running_services[@]}"
    fi
  }

  trap restart_services EXIT

  # Create a backup directory
  mkdir -p ./backups

  # Stop application writers first so Redis and SQLite are quiescent during the backup
  docker-compose -f "$compose_file" stop api daemon worker

  # Force Redis to flush in-memory queue and cache state to disk before snapshotting its volume
  docker-compose -f "$compose_file" exec -T redis redis-cli SAVE

  # Stop Redis after its on-disk snapshot has been updated
  docker-compose -f "$compose_file" stop redis

  # Back up the shared SQLite volume
  docker run --rm \
    -v propr-sqlite-data:/from \
    -v "$PWD/backups":/to \
    alpine sh -c "cd /from && tar -czf /to/propr-sqlite-data-${backup_date}.tar.gz ."

  # Back up the Redis volume
  docker run --rm \
    -v propr-redis-data:/from \
    -v "$PWD/backups":/to \
    alpine sh -c "cd /from && tar -czf /to/propr-redis-data-${backup_date}.tar.gz ."

  # Back up bind-mounted repository and log data
  tar -czf "./backups/propr-files-backup-${backup_date}.tar.gz" \
    ./repos \
    ./logs
)
```

Do not rely on the `./repos` and `./logs` archive by itself. That file backup is only partial and does not preserve the shared SQLite application database or Redis queue state. If you use a managed Docker platform, replace the example above with the equivalent named-volume snapshot process for `propr-sqlite-data` and `propr-redis-data`.

### Scaling

To handle more load, you can scale the worker service:

```bash
docker-compose -f docker-compose.prod.yml up -d --scale worker=3
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
# Check Redis keys
docker-compose -f docker-compose.prod.yml exec redis redis-cli KEYS '*'

# Monitor Redis activity
docker-compose -f docker-compose.prod.yml exec redis redis-cli MONITOR

# Check queue status
docker-compose -f docker-compose.prod.yml exec redis redis-cli LLEN github-issue-processor

# View recent activities
docker-compose -f docker-compose.prod.yml exec redis redis-cli LRANGE system:activity:log 0 10
```

## Security Recommendations

1. **Use strong secrets** for SESSION_SECRET
2. **Enable HTTPS** for all production deployments
3. **Restrict access** using ALLOWED_ORGS
4. **Regular updates** of Docker images and dependencies
5. **Monitor logs** for suspicious activity
6. **Backup regularly** and test restore procedures

## Performance Tuning

Adjust these settings based on your needs:

- `WORKER_CONCURRENCY`: Number of jobs processed simultaneously (default: 5)
- `POLLING_INTERVAL_MS`: How often daemon checks for new issues (default: 60000ms)
- Redis memory limits in docker-compose configuration
- Worker container CPU/memory limits
