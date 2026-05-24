# LLM Metrics Documentation

This document describes the shared LLM metrics collection and monitoring functionality implemented in ProPR.

## Overview

The LLM metrics system tracks and stores detailed metrics about agent execution across ProPR, including:
- Success/failure rates
- Cost tracking (per request and aggregated)
- Execution time
- Number of conversation turns
- Model-specific performance
- High-cost alerts

The current implementation normalizes execution results into a shared metrics payload and stores them under generic `llm:*` keys. Some code-level type names and detailed conversation fields still use Claude-oriented naming because the metrics pipeline originated from Claude execution logs, but the dashboard aggregates any recorded model ID.

## Architecture

### Components

1. **`packages/core/src/utils/llmMetrics.ts`** - Core metrics recording and retrieval functions
2. **`packages/api/llmMetricsAdapter.ts`** - Dashboard adapter for summary endpoints
3. **`propr-ui/src/components/Dashboard.tsx`**, **`propr-ui/src/components/TopModels.tsx`**, and **`propr-ui/src/pages/LlmLogsPage.tsx`** - Current frontend surfaces for summary cards, model usage views, and execution drill-downs
4. **Redis Storage** - All metrics are stored in Redis with appropriate TTLs

### Data Flow

1. When an agent execution completes, the normalized result is passed to `recordLLMMetrics()`
2. Metrics are extracted and stored in Redis with various aggregation levels
3. The dashboard API exposes endpoints to retrieve metric summaries
4. The Web UI in `propr-ui/` displays summary cards, model breakdowns, and drill-down views from those API responses

## Metrics Collected

### Per-Request Metrics
- **Correlation ID** - Unique identifier for tracking
- **Issue/PR Number** - Associated GitHub issue or PR
- **Repository** - Repository being processed
- **Model** - Model ID used for the execution
- **Success/Failure** - Whether the request succeeded
- **Execution Time** - Time taken in milliseconds
- **Number of Turns** - Conversation turns used
- **Cost** - USD cost of the request
- **Session ID** - Session or provider-specific execution identifier when available
- **Error Details** - If failed, the error message

### Aggregated Metrics
- **Total Requests** - Count of all LLM requests
- **Success Rate** - Percentage of successful requests
- **Total Cost** - Cumulative cost in USD
- **Average Cost per Request**
- **Average Turns per Request**
- **Average Execution Time**
- **Model-specific Breakdowns** - All metrics broken down by model

### Time Series Data
- **Daily Metrics** - Success/failure counts and costs per day
- **Recent Activity** - Last 1000 LLM requests for analysis

## Redis Key Structure

```
llm:metrics:{correlationId}              # Individual request data (30-day TTL)
llm:metrics:total:successful             # Total successful requests counter
llm:metrics:total:failed                 # Total failed requests counter
llm:metrics:total:costUsd                # Total cost accumulator
llm:metrics:total:turns                  # Total turns counter
llm:metrics:total:executionTimeMs        # Total execution time
llm:metrics:daily:{YYYY-MM-DD}:successful # Daily success counter
llm:metrics:daily:{YYYY-MM-DD}:failed    # Daily failure counter
llm:metrics:daily:{YYYY-MM-DD}:costUsd   # Daily cost accumulator
llm:metrics:model:{model}:successful     # Model-specific success counter
llm:metrics:model:{model}:failed         # Model-specific failure counter
llm:metrics:model:{model}:costUsd        # Model-specific cost
llm:metrics:model:{model}:turns          # Model-specific turns
llm:metrics:model:{model}:executionTimeMs # Model-specific execution time
llm:metrics:models:used                  # Set of all models used
llm:metrics:timeseries                   # List of recent requests (capped at 1000)
llm:metrics:alerts:highcost              # List of high-cost alerts (capped at 100)
```

## API Endpoints

### `GET /api/llm-metrics`
Returns comprehensive LLM metrics summary including:
- Overall statistics
- Model-specific breakdowns
- Daily metrics for the last 7 days
- Recent high-cost alerts

### `GET /api/llm-metrics/:correlationId`
Returns detailed metrics for a specific request by correlation ID.

## High-Cost Alerts

When a request exceeds the cost threshold (default: $10.00, configurable via `LLM_COST_THRESHOLD_USD`), an alert is generated and stored. Alerts include:
- Timestamp
- Correlation ID
- Issue/repository details
- Actual cost vs threshold
- Model used
- Number of turns

## Configuration

### Environment Variables
- `LLM_COST_THRESHOLD_USD` - Cost threshold for alerts (default: 10.00)
- `REDIS_HOST` - Redis host (default: 127.0.0.1)
- `REDIS_PORT` - Redis port (default: 6379)

## Dashboard Integration

The current Web UI surfaces LLM usage through:

- Dashboard summary cards and top-model views
- Repository-level usage and cost breakdowns
- The LLM Log page for request-by-request drill-downs

Additional dashboard pages can consume the same API endpoints if you want a dedicated metrics screen in your deployment.

## Usage Examples

### Recording Metrics
```javascript
import { recordLLMMetrics } from '@propr/core';

// After an agent execution has been normalized to the shared metrics payload
await recordLLMMetrics(
    executionResult,
    { number: 123, repoOwner: 'owner', repoName: 'repo' },
    { jobType: 'issue', correlationId }
);
```

### Retrieving Metrics
```javascript
import { getLLMMetricsSummary, getLLMMetricsByCorrelationId } from '@propr/core';

// Get overall summary
const summary = await getLLMMetricsSummary();

// Get specific request metrics
const metrics = await getLLMMetricsByCorrelationId('corr-123');
```

## Monitoring and Analysis

The metrics system enables:
1. **Cost Optimization** - Track spending and identify expensive operations
2. **Performance Monitoring** - Monitor execution times and turn counts
3. **Model Comparison** - Compare configured model performance across agents
4. **Failure Analysis** - Identify patterns in failed requests
5. **Usage Trends** - Track daily usage patterns and costs

## Future Enhancements

Potential improvements:
1. Export metrics to external monitoring systems (Prometheus, Grafana)
2. Automated cost optimization recommendations
3. Per-repository cost tracking
4. User-specific usage tracking
5. Predictive cost alerts based on usage patterns
