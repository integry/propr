# Task entity query benchmark

Issue #2403 replaces the task list's global latest-history window and global
presentation enrichment with an indexed latest-state lookup followed by
page-scoped enrichment.

## Reproduce

From the repository root:

```sh
npm run benchmark:task-entities
```

The command creates an in-memory, disposable SQLite database. It does not read
or modify the instance database. Fixture size and repetitions can be changed,
for example:

```sh
npm run benchmark:task-entities -- --tasks=20000 --history=12 --executions=3 --iterations=30 --warmups=5 --page-size=50
```

The benchmark compares the complete legacy count/page operation with
`getTasksFromDb`, verifies that both return the same task identities and total,
and prints the p50/p95 timings and query plans as JSON.

## Recorded result

Recorded on 2026-09-14 with Node v22.23.1, SQLite 3.49.2, and an AMD Ryzen 5
3600. The warm-cache fixture contained 20,000 tasks, 240,000 history rows,
60,000 LLM executions, and 4,000 plan-issue links. Each result used five
warmups and 30 measured iterations for an unfiltered 50-task newest-first page.

| Implementation | p50 | p95 |
| --- | ---: | ---: |
| Legacy global window/enrichment | 617.66 ms | 655.83 ms |
| Indexed lookup/page enrichment | 19.04 ms | 21.61 ms |
| Speedup | 32.43x | 30.34x |

The legacy latest-history plan included:

```text
SCAN task_history USING INDEX task_history_task_id_index
USE TEMP B-TREE FOR LAST TERM OF ORDER BY
SCAN (subquery-4)
```

After the migration, the latest-history portion was:

```text
CORRELATED SCALAR SUBQUERY 1
SEARCH latest_h USING COVERING INDEX task_history_task_id_timestamp_index (task_id=?)
SEARCH h USING INTEGER PRIMARY KEY (rowid=?)
```

No temporary history sort remained. The optimized endpoint first limits task
identities, then constrains lifecycle, plan status, and critique queries to
those page IDs.

## Index and related-path review

The migration replaces `task_history(task_id)` with
`task_history(task_id, timestamp DESC)`. Keeping both would duplicate the
leading-key lookup and increase write cost. The composite index also benefits
the task-history route and other task-scoped history reads.

No new `llm_executions` index was added. SQLite stores the rowid
(`execution_id`) in the existing `llm_executions(task_id)` index, which already
supports page-scoped execution retrieval. Major stats queries intentionally
aggregate across all entities, while live-details, execution-details, and MCP
entity paths are already task-scoped; they were left unchanged rather than
mixing unrelated speculative rewrites into this change.

## Remaining uncertainty

This is a synthetic, warm-cache, in-process SQLite benchmark, not a production
latency measurement. Real endpoint latency also includes authorization,
request scheduling, filesystem/cache state, concurrent writers, serialization,
and network/browser time. Production validation should use read-only request
timings and `EXPLAIN QUERY PLAN` after the normal coordinated migration and
deployment; this worker did not access, migrate, benchmark, or restart any
production service.
