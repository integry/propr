---
title: Synthetic Pools
---

# Synthetic Pools

Synthetic pools give a stable virtual agent/model identity to a set of existing direct agent accounts. They are useful for rotating between two accounts from one provider, balancing capacity, or failing over to a different provider without changing repository, planner, review, or issue configuration.

## Concepts

- A **synthetic agent** is a virtual coding agent. It has an alias and one or more synthetic models but no provider credentials of its own.
- A **synthetic model** is a virtual model ID exposed in ProPR's instance catalog and model selectors.
- A **pool member** is one direct-agent alias and one physical model supported by that direct agent. A synthetic agent can never be a member of another pool.
- A **priority tier** is the set of currently eligible members with the same priority, from 0 through 100. Routing considers only the highest eligible tier.
- A **usage cap** makes a member ineligible when its current session or weekly usage reaches a configured percentage.
- **Failover** retries a synthetic call on another eligible member after a retryable physical failure.

Synthetic choices use a neutral layers icon in the UI because the pool is not owned by a provider. Task lists keep their model column concise by showing the virtual model. Playground results, task details, task-history attempts, and LLM logs also show the physical agent/model that actually ran.

## Configure in the Web UI

Installation administrators can open **Coding Agents → Synthetic Pools** to create, edit, enable, disable, or delete pools. Each virtual model supports **Round robin** or **Usage based** routing, an enabled state, and one or more direct members. Each member has an enabled state, priority, and optional session and weekly maximum percentages.

The member picker contains only configured direct agents and their supported physical models. Disabled direct agents remain visible for correcting existing configuration but are not eligible at runtime. Demo mode is read-only and disables every mutation.

Backend validation is authoritative. A rejected save keeps the editor and unsaved values open and associates a validation message with its nested model/member field when the response contains a field path.

### Same-provider round robin

Create two direct Codex agents, such as `codex-account-a` and `codex-account-b`, using separate credential directories. Add both with the same physical model to one enabled virtual model, give both priority 100, and choose **Round robin**. Successful calls rotate between the two accounts using a cursor shared by the workers.

### Usage-based selection

**Usage based** still honors strict priority first. Within the highest eligible tier it selects the member with the most normalized headroom below its configured caps. If no caps are configured, all members have equal headroom; use round robin when deterministic rotation is the goal.

## Primary and fallback recipe

For cross-provider primary/fallback routing:

1. Add the primary member at priority 100.
2. Optionally set its weekly maximum to 80%.
3. Add the fallback member at priority 0.
4. Use either strategy; strategy only chooses among members inside the selected priority tier.

The priority-0 member is not mixed into normal traffic. It becomes eligible for selection only when every higher-priority member is disabled, capped, unavailable, too small for the call's context, or has failed during that call. This priority-100 primary plus priority-0 fallback pattern is the recommended way to reserve fallback capacity.

## Context-aware early selection

ProPR can select a route early so planning and task setup retain one stable physical choice. Before the first physical invocation it finalizes the required prompt plus output reserve. If the selected model's context limit is too small, ProPR reselects without counting that member as a failed attempt.

Every later failover applies the same context requirement. A smaller-context fallback can therefore be skipped even when it is healthy: sending a prompt that cannot fit would only create a misleading provider failure.

## Usage data and degraded pools

A capped member requires fresh Agent Tank data whose name exactly matches the direct-agent alias. Missing, refreshing, stale, provider-wide-only, or differently named data makes that capped member ineligible. The default freshness window is five minutes and can be changed with `SYNTHETIC_USAGE_FRESHNESS_MS`.

Uncapped pools do not require Agent Tank. If no member of a synthetic model is currently eligible, the pool reports **Degraded**. This does not mark its unrelated direct agents unhealthy; direct-agent health remains independent.

## Failure retries and workspace preservation

A retryable physical error fails over to the next eligible, not-yet-attempted member. Every physical attempt is recorded as a separate history entry with the virtual identity, physical agent/model, attempt number, and selection reason. These attempts remain part of one task: ProPR does not create extra tasks or extra worktrees.

Implementation retries reuse the same task workspace and branch, so edits made before a provider failure remain available to the fallback. Explicit user cancellation, security-policy failures, invalid configuration, and prompts that exceed the context limit are not retried on another member.

## CLI

The CLI manages the same complete configuration document:

```bash
propr agent pool list
propr agent pool list --json > pools.json
propr agent pool apply pools.json
cat pools.json | propr agent pool apply -
propr agent pool delete balanced-pool
propr agent pool delete balanced-pool --json
```

`pool list --json` emits `{ "synthetic_agents": [...] }`. That file can be passed unchanged to `pool apply`; `apply` also accepts the array itself. Full-document replacement keeps nested multi-model configuration unambiguous and makes review, backup, and automation straightforward. Backend validation messages, including nested field paths, are printed without being rewritten.

An abbreviated two-tier document looks like this (IDs must be UUIDs):

```json
{
  "synthetic_agents": [{
    "id": "11111111-1111-4111-8111-111111111111",
    "alias": "balanced-pool",
    "enabled": true,
    "defaultModel": "balanced",
    "models": [{
      "id": "balanced",
      "displayName": "Balanced",
      "enabled": true,
      "strategy": "usage_based",
      "members": [
        {
          "id": "22222222-2222-4222-8222-222222222222",
          "directAgentAlias": "codex-primary",
          "model": "gpt-5.6-sol",
          "enabled": true,
          "priority": 100,
          "usageLimits": { "weeklyMaxPercent": 80 }
        },
        {
          "id": "33333333-3333-4333-8333-333333333333",
          "directAgentAlias": "claude-fallback",
          "model": "claude-sonnet-5",
          "enabled": true,
          "priority": 0
        }
      ]
    }]
  }]
}
```
