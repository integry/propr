# Dashboard Usage Tips

A compact strip beneath historical dashboard statistics links to documented ProPR capabilities. A worker ranks installation-relevant tips approximately once a day using the repository indexing agent and its configured fallback. Each tip explains why it fits your workflow using observed activity in your instance, suggests a documented action, and describes how it could help. These recommendations use installation-wide signals, not individual activity histories. If model generation fails, signal-based recommendations still explain the context and benefit. No extra model setting is needed. Up to three eligible tips appear; fewer or none is normal.

## Goals and launch strategies

Goals support two launch strategies: **Direct** (the agent implements directly) opens a draft PR and commits changes at checkpoints; **Orchestrate through ProPR** lets the agent decompose work, create issues, and start and monitor their implementation. Use Goals for an ongoing objective and Planner Studio when you want to inspect and refine a plan before running it.

## Temporary dismissal

Dismissals belong to your user account. Dismissing a tip hides it immediately and starts a cooling-off period. At the default 45 days, successive deliberate dismissals cool down for **45, 180, 720, and 2,880 days**. Further growth is capped at **3,650 days**. Expiry retains the lifetime dismissal count. A tip becomes eligible exactly at the cooldown boundary, but only appears if it remains relevant in the current selection. New relevance never overrides an active cooldown.

Settings → Automation → **Usage tips** exposes **Show usage tips** (enabled by default) and **Dismissal cooldown days** (an integer from 1 to 365, default 45). Changing the base period recalculates existing cooldowns from each stored dismissal timestamp and lifetime count. Disabling tips hides the strip and stops daily selection.

The CLI exposes the same settings:

```sh
propr setting update usage_tips_enabled false
propr setting update usage_tips_dismissal_cooldown_days 60
```

A failed dismissal is retried with the same event identifier. If persistence still fails, the tip returns with a quiet retry control. Duplicate delivery never increases the count or restarts the cooldown.

## Relevance and privacy

There are two kinds of tips:

- **Corrective** tips suggest improvements to observed workflows, such as replacing repeated manual review and fix cycles with `/ultrafix`.
- **Discovery** tips introduce unused capabilities and carry a small **New to you** label. They cover [MCP chat control](./mcp-chat.md), visual previews, repository chat, and Epic mode with auto-merge.

The daily job uses guarded installation-wide aggregates; unavailable signals remain unknown. Discovery requires a known usage count of exactly zero and a useful prerequisite: at least three recent tasks for MCP, visual previews, and repository chat, or at least two plans for Epic mode. Unknown usage or any recorded use excludes discovery. An installation without known activity gets no discovery tips. Counts describe retained activity or current configuration, not a personal feature history: previews use enabled repository settings, chat uses saved messages, Epic uses plan configuration, and MCP uses recorded calls. Corrective tips exclude features already used regularly.

Discovery scores occupy the 70–79 range, below strong corrective gaps. Candidates rotate deterministically within ten-point relevance bands. After unknown IDs and cooling tips are removed, the strip mixes up to three tips: when both kinds are eligible, at least one and at most two of each kind appear, preserving their order in the rotated pool. Dismissing one replaces it with the next eligible tip of that kind; the other kind fills the space only when none remain. A sole eligible kind can fill all three slots and recur daily. The saved order remains stable across reloads.

**Display history is not tracked.** Rendering, mounting, reloading and reading tips record no impressions, display counts, first/last-shown timestamps, or acknowledgements. Only an explicit dismissal records acknowledgement. Previous selection does not make a tip ineligible.

The committed catalog is generated from documentation with `npm run tips:generate`. Its stable identities survive wording changes, preserving dismissal history. Runtime services import the catalog and never read the documentation tree.
