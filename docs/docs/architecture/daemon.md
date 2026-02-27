---
sidebar_position: 2
---

# Daemon Architecture

The daemon is responsible for monitoring GitHub repositories and detecting issues eligible for AI processing.

## Overview

The daemon (`src/daemon.js`) is a long-running service that:

1. Polls configured GitHub repositories at regular intervals
2. Searches for issues with configured primary labels
3. Detects model-specific labels to determine which Claude models to use
4. Creates jobs in the Redis queue for worker processing
5. Tracks issue state through GitHub labels

## Core Responsibilities

### Repository Monitoring

The daemon monitors multiple repositories simultaneously based on configuration:

```bash
GITHUB_REPOS_TO_MONITOR=owner/repo1,owner/repo2,owner/repo3
POLLING_INTERVAL_MS=60000  # Poll every 60 seconds
```

On each poll cycle, the daemon:
- Fetches open issues from each configured repository
- Filters for issues with primary processing labels
- Excludes issues already being processed or completed

### Label Detection

#### Primary Labels

Primary labels trigger issue processing:

```bash
PRIMARY_PROCESSING_LABELS=AI,propr,automation
```

Any issue with one of these labels is considered for processing.

#### State Labels

State labels are dynamically generated based on the triggering primary label:

- `{primary}-processing` - Issue is currently being processed
- `{primary}-done` - Issue has been successfully processed
- `{primary}-failed-*` - Issue processing failed (with reason)

**Examples:**
- Issue with `AI` label → Uses `AI-processing`, `AI-done`, `AI-failed-*`
- Issue with `propr` label → Uses `propr-processing`, `propr-done`, `propr-failed-*`

#### Model Labels

Model-specific labels determine which Claude models process the issue:

```bash
MODEL_LABELS_SONNET=llm-claude-sonnet
MODEL_LABELS_OPUS=llm-claude-opus
```

An issue can have:
- No model labels → Processed by default model
- One model label → Processed by that model only
- Multiple model labels → Processed by each model independently

### Job Creation

For each eligible issue, the daemon:

1. Determines which models should process it
2. Creates a separate job in Redis for each model
3. Includes complete issue context in the job data:
   - Issue number, title, body
   - Repository owner and name
   - Model to use
   - Primary label that triggered processing
   - Correlation ID for tracking

### Deduplication

The daemon prevents duplicate job creation by:

1. Checking for state labels before enqueueing
2. Tracking jobs already in the Redis queue
3. Skipping issues that are already active or completed

## Algorithm Flow

```
1. Start polling loop
   ↓
2. For each configured repository
   ↓
3. Fetch all open issues via GitHub API
   ↓
4. Filter issues:
   - Must have at least one primary label
   - Must NOT have any state labels
   ↓
5. For each eligible issue:
   a. Detect model labels
   b. Create job(s) for each model
   c. Add job(s) to Redis queue
   ↓
6. Wait for polling interval
   ↓
7. Repeat from step 2
```

## Configuration

### Environment Variables

```bash
# Repository monitoring
GITHUB_REPOS_TO_MONITOR=owner/repo1,owner/repo2
POLLING_INTERVAL_MS=60000

# Label configuration
PRIMARY_PROCESSING_LABELS=AI,propr
MODEL_LABELS_SONNET=llm-claude-sonnet
MODEL_LABELS_OPUS=llm-claude-opus

# GitHub authentication
GH_APP_ID=your_app_id
GH_PRIVATE_KEY_PATH=./your-app-private-key.pem
GH_INSTALLATION_ID=your_installation_id

# Redis connection
REDIS_HOST=localhost
REDIS_PORT=6379
```

### Command Line Options

```bash
# Normal operation
npm run daemon

# Development mode with debug logging
npm run daemon:dev

# Reset mode - clears queue and removes labels
npm run daemon:reset:dev
```

## Reset Mode

The daemon supports a reset mode that cleans up stale state:

```bash
node src/daemon.js --reset
```

This mode:
1. Clears all Redis queue data (waiting, active, completed, failed)
2. Removes processing and done labels from all issues
3. Allows issues to be reprocessed from a clean state
4. Exits after reset (doesn't start monitoring)

Use this when:
- Jobs are stuck in processing state
- Labels are out of sync with actual job state
- Queue needs to be completely reset

## Multi-Model Job Creation

When an issue has multiple model labels, the daemon creates independent jobs:

**Example Issue:**
```
Issue #123
Labels: AI, llm-claude-sonnet, llm-claude-opus
```

**Jobs Created:**
1. Job for Sonnet model
   - Branch: `ai-fix/123-title-timestamp-sonnet-random`
   - Queue: `propr-issues`
   - Model: `claude-sonnet-4-5-20250929`

2. Job for Opus model
   - Branch: `ai-fix/123-title-timestamp-opus-random`
   - Queue: `propr-issues`
   - Model: `claude-opus-4-20250514`

Each job is completely independent and can be processed concurrently.

## Error Handling

The daemon implements robust error handling:

### GitHub API Errors

- Automatic retry with exponential backoff
- Rate limit detection and waiting
- Authentication failure alerts

### Redis Connection Errors

- Automatic reconnection attempts
- Graceful degradation if Redis is unavailable
- Connection status logging

### Invalid Configuration

- Early validation of environment variables
- Clear error messages for missing or invalid config
- Graceful exit if critical config is missing

## Performance Considerations

### Polling Interval

The polling interval balances responsiveness with API rate limits:

- **Too short** (< 30s): May hit GitHub API rate limits
- **Recommended** (60s): Good balance for most use cases
- **Too long** (> 300s): Delays issue detection

### Batch Operations

The daemon uses batch operations where possible:
- Fetches all open issues in a single API call
- Filters in-memory rather than multiple API calls
- Reuses GitHub API client across poll cycles

### Memory Usage

The daemon is designed to run indefinitely with stable memory:
- No accumulation of job data
- Periodic garbage collection
- Limited issue history tracking

## Monitoring

The daemon logs important events:

```javascript
// Startup
logger.info('Daemon started', {
  repositories: config.repos,
  pollingInterval: config.interval,
  primaryLabels: config.primaryLabels
});

// Issue detection
logger.info('Issue detected', {
  issueNumber: issue.number,
  repository: repo,
  models: detectedModels,
  correlationId: correlationId
});

// Job creation
logger.info('Job enqueued', {
  issueNumber: issue.number,
  model: model,
  jobId: job.id
});
```

Use these logs to:
- Track daemon health
- Debug issue detection problems
- Monitor job creation rate
- Identify configuration issues

## Integration with Workers

The daemon and workers communicate through Redis:

1. Daemon adds jobs to queue
2. Workers pull jobs from queue
3. Workers update job status in Redis
4. Workers update GitHub labels
5. Daemon sees updated labels and skips those issues

This decoupled design allows:
- Independent scaling of daemons and workers
- Multiple daemons for redundancy
- Zero coordination required between components

## Best Practices

1. **Run one daemon per environment** - Multiple daemons can cause duplicate jobs
2. **Monitor daemon logs** - Watch for API rate limits or errors
3. **Use appropriate polling interval** - Balance responsiveness with API limits
4. **Configure multiple repositories carefully** - Consider total API call volume
5. **Set up health checks** - Monitor daemon uptime and restart if needed
6. **Use correlation IDs** - Track issues from detection through completion
