# Maintenance And Troubleshooting

Use this page after ProPR is already running.

## Updating

For launcher-based installs, restart with the newer published image tag:

```bash
docker pull propr/launcher:latest
```

For source-based Compose deployments:

```bash
git pull
docker-compose -f docker-compose.prod.yml build
docker-compose -f docker-compose.prod.yml up -d
```

## Backups

Back up:

- SQLite application data
- Redis data
- Repository workspaces
- Logs
- Production `.env` or secret source

Do not back up only `repos` and `logs`. They do not contain the full application state.

## Common Issues

### Dashboard Shows Unauthorized

Check OAuth settings, `SESSION_SECRET`, `FRONTEND_URL`, callback URL, and organization allowlists.

### Worker Not Processing Issues

Check Redis, GitHub App permissions, worker logs, agent credentials, repository settings, labels, and enabled agents.

### Metrics Not Updating

Check that Redis is running, workers are processing jobs, task records are being written, and dashboard API logs are clean.

## Debugging

Start with:

```bash
docker ps
docker logs <container>
```

Use Redis inspection carefully on production systems. Avoid `KEYS '*'`; use scan-based queries instead:

```bash
docker-compose -f docker-compose.prod.yml exec redis redis-cli --scan --pattern 'bull:*'
```

## Security Checks

- Use strong secrets.
- Enable HTTPS in production.
- Restrict access to the Docker socket.
- Restrict mounted credential directories.
- Keep images updated.
- Test restore procedures.

## Tuning

Increase concurrency only when the bottleneck is clear. Watch queue depth, task duration, provider rate limits, disk usage, CPU, and memory.
