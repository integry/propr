# Production Deployment Guide

This guide covers deploying GitFix with the Web UI dashboard in a production environment.

## Prerequisites

- Docker and Docker Compose installed
- A domain name for your deployment
- SSL/TLS certificates (recommended)
- GitHub App configured with proper permissions
- Anthropic API key for Claude

## Environment Configuration

1. Copy the example environment files:
```bash
cp .env.example .env
cp packages/dashboard/.env.example packages/dashboard/.env
cp packages/dashboard/client/.env.example packages/dashboard/client/.env
```

2. Update the `.env` file with production values:

### Required Environment Variables

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

# Claude API
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

# Logging
LOG_LEVEL=info
```

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
- Redis data: `redis-data` volume
- Repository data: `./repos` directory
- Logs: `./logs` directory

```bash
# Backup Redis data
docker-compose -f docker-compose.prod.yml exec redis redis-cli BGSAVE

# Create backup archive
tar -czf gitfix-backup-$(date +%Y%m%d).tar.gz \
  ./repos \
  ./logs \
  docker-volume-backup-redis-data
```

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
- `POLL_INTERVAL`: How often daemon checks for new issues (default: 60000ms)
- Redis memory limits in docker-compose configuration
- Worker container CPU/memory limits