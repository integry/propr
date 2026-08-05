---
sidebar_position: 9
---

# PR Comment Recovery Protocol

PR-comment implementation jobs coordinate Redis, BullMQ, SQL, GitHub, and the
agent container. These stores are not one transaction, so recovery relies on a
single attempt identity and ordered, idempotent checkpoints.

## Fences and ownership

| Value | Store | Invariant |
| --- | --- | --- |
| PR lease token | Redis lock, current task state, active BullMQ job | Only the holder may write state, publish a checkpoint, mark review comments, or clean up its runtime. The raw token is not used as a public identifier. |
| Attempt generation | Hash of the lease token in SQL, BullMQ results, and publication checkpoints | Every supplied raw token and generation must independently match the current task attempt. A valid caller token never authorizes a stale result. |
| Task revision | Separate Redis revision key | Revisions increase monotonically across state expiry and task recreation. State cleanup retains this longer-lived key until its own TTL expires. |
| SQL generation | `tasks.attempt_generation` | Updates such as commit-hash persistence affect exactly one row for the active generation; zero rows mean the attempt was superseded. |
| Runtime ownership | Exact Docker labels and generation-specific process callbacks | A successor may stop an abandoned predecessor, but callbacks from that predecessor cannot mutate the successor's task. |

Redis task-state compare-and-set operations check the complete expected state
and increment the durable revision atomically. Socket consumers can therefore
discard out-of-order events without hiding a later recreation behind an old
revision.

## Publication stages

| Stage | Durable evidence | Recovery action |
| --- | --- | --- |
| `push_pending` | Exact local commit SHA and completion body recorded immediately before the push | Read the remote branch. If it contains the SHA, advance to `branch_pushed`; otherwise clear this fenced checkpoint and rerun the agent. |
| `branch_pushed` | Remote branch contains the commit; body and `/undo` payload reference that same SHA | Publish or update the completion comment. |
| `completion_comment_published` | GitHub comment URL and returned body | Mark consumed AI review comments under the live lease. |
| `review_comments_processed` | Review-comment mutation completed | Run the ultrafix continuation step. |
| `continuation_handled` | Continuation work completed | Persist `tasks.commit_hash` for the matching SQL generation. Database errors remain retryable and do not advance the stage. |
| `commit_hash_persisted` | SQL write completed or no commit exists | Persist the terminal remote outcome, enqueue deterministic cleanup recovery, and transition Redis task state. |

The git push callback rewrites `push_pending` after an automatic rebase, before
the rebased commit is sent. This closes both post-push crash windows: recovery
can recognize the remote mutation, and the first `branch_pushed` checkpoint
already has a completion body consistent with the final SHA.

## Retry rules

- Lease loss and generation mismatch fail closed. The stale attempt performs no
  further external writes.
- Redis or GitHub failures before a stage is checkpointed retry that stage.
- A transient SQL commit-hash failure leaves the checkpoint at
  `continuation_handled`, so recovery retries the database update.
- Cleanup recovery uses one deterministic BullMQ job ID per repository, pull
  request, and attempt generation. Repeated scheduling is idempotent.
- A terminal remote outcome takes precedence over rerunning the agent. Redis
  task-state finalization may be repaired later by worker hooks or reconciliation.

Keep new cross-store side effects inside this sequence. If an effect is not
idempotent, record enough evidence before or immediately after it to distinguish
"not attempted" from "committed but not acknowledged."
