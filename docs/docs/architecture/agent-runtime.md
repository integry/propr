---
sidebar_position: 6
---

# Agent Runtime Reference

The worker selects the agent’s configured runtime, then the instance default (`PROPR_AGENT_RUNTIME`), then Docker. Choose a runtime that supports the provider and the repository’s network policy.

| Capability | Docker (`docker`) | Sprites (`sprites`) | Fly Machines (`fly-machines`) |
| --- | --- | --- | --- |
| Coding agents | Claude Code, Codex, Antigravity, OpenCode, Mistral Vibe | Claude Code, Codex, Antigravity | Claude Code, Codex |
| Workspace | Host worktree or clone | Clone with scoped token | Clone with scoped token |
| Isolation and lifetime | Container per run on the operator’s daemon | One run per leased Sprite, restored to a clean checkpoint before reuse | Fresh Machine per run, destroyed after result retrieval |
| Restricted network | Worker allowlist proxy | Sprite DNS allowlist | Restricted runs refused |
| Extension Library | Skill bundles, URL, package and operator catalog stdio MCP servers | Skill bundles, URL and package MCP servers | Skill bundles, URL and package MCP servers |
| Capacity | Host CPU, RAM and worker concurrency | Redis-backed pool, default two Sprites | Available Machine slots in the agent app’s organization |

For what each runtime gives the agent from the Extension Library and elsewhere, see [Extensions by runtime](#extensions-by-runtime). For the run contract see [Coding Agent Integration](./coding-agent-integration.md). For a control plane that delegates all agent work to Fly, follow [Run ProPR on Fly](../tutorials/setup-fly.md).

## Runtime Model

By default, each coding agent runs in a Docker container so ProPR can control runtime dependencies, workspace mounts, credential mounts, timeouts, logging, and resource boundaries. The agent implementation changes the CLI command, image, credential directory, and output parser, but the container shape is shared:

- A task worktree mounted at `/home/node/workspace`
- Agent credentials from a ProPR-managed per-agent directory or a configured existing host directory. Task and analysis runs get a per-run copy holding only the provider's credential and config files, and refreshed tokens are written back after the run (see [Per-run credential copies](../features/execution-safety.md#per-run-credential-copies)).
- GitHub credentials passed through `GH_TOKEN` and `GITHUB_TOKEN`
- Agent, model, timeout, and task metadata passed as environment variables or CLI flags
- `--security-opt no-new-privileges`, `--cap-add CHOWN` (Vibe omits it), and Docker's default `bridge` network; the repository setup hook runs without sudo privileges before the agent entrypoint
- Memory, CPU, and process limits from `AGENT_CONTAINER_MEMORY_LIMIT` (default `6g`), `AGENT_CONTAINER_CPU_LIMIT` (default: available CPUs, capped at 4), and `AGENT_CONTAINER_PIDS_LIMIT` (default `512`)
- For every agent except Vibe, the host's `/tmp/git-processor` directory (all clones and worktrees) mounted at the same path so git works in the linked worktree
- Structured stdout, stderr, exit code, duration, session ID, and token usage capture when the CLI exposes those fields

Docker agents run from the unified Debian/glibc `propr/agent` image. Its internal base stage includes Node.js 22, Git and repository tooling, a scoped `gh` wrapper, and entrypoint support used by the worker. The image uses Node.js 22 to satisfy current agent CLI engine requirements. Independent CLI build stages preserve Docker cache reuse when one configured version changes.

This table maps each agent type to the unified image, its type-specific entrypoint, and its credential mount; other pages link here instead of repeating it.

| Agent | Image | Dockerfile | Entrypoint | Existing host credential mount | Container credential path |
| --- | --- | --- | --- | --- | --- |
| Claude Code | `propr/agent` | `Dockerfile.agent` | `scripts/claude-entrypoint.sh` | `HOST_CLAUDE_DIR` (`~/.claude`) | `/home/node/.claude` |
| Codex | `propr/agent` | `Dockerfile.agent` | `scripts/codex-entrypoint.sh` | `HOST_CODEX_DIR` (`~/.codex`) | `/home/node/.codex` |
| Antigravity | `propr/agent` | `Dockerfile.agent` | `scripts/antigravity-entrypoint.sh` | `HOST_ANTIGRAVITY_DIR` (`~/.gemini`) | `/home/node/.gemini` |
| OpenCode | `propr/agent` | `Dockerfile.agent` | `scripts/opencode-entrypoint.sh` | `HOST_OPENCODE_XDG_DIR` (`~/.config/opencode`) plus `HOST_OPENCODE_DATA_DIR` | `/home/node/.config/opencode` |
| Mistral Vibe | `propr/agent` | `Dockerfile.agent` | `scripts/vibe-entrypoint.sh` | `HOST_VIBE_DIR` (`~/.vibe`) | `/home/node/.vibe` |

Agent runs go through the runtime seam described in [Coding Agent Integration](./coding-agent-integration.md#runtime-seam). Docker is the default runtime (`PROPR_AGENT_RUNTIME=docker`). The container shape below is how `DockerRuntime` renders each provider's `AgentRunSpec`. With `PROPR_WORKSPACE_TRANSPORT=clone`, the worktree and git mounts are left out. The container clones the task base with a short-lived repository-scoped token and returns its result through a temporary `refs/propr/runs/<runId>/result` ref, falling back to a bundle. It also runs without `--rm` so the worker can read the result files before removing it. See [Workspace Transport](./coding-agent-integration.md#workspace-transport).

## Runtime Packages

Instance runtime packages (Settings → Agent extensions & packages → Agent runtime packages, or `propr runtime packages`) are `apt` packages every run should have. Each runtime installs them from its own apt sources, so a name or pinned version is checked against the distribution that runtime actually runs:

| Runtime | Distribution and apt sources | How packages are applied |
| --- | --- | --- |
| Docker | The agent image: Debian 12 (bookworm), plus GitHub's `cli.github.com` repository that `Dockerfile.agent` adds for `gh`. | The worker builds a derived image from each agent base image (`apt-get install` in a generated Dockerfile) and runs agents from it. The Docker build status (`pending`, `building`, `ready`, `failed`) tracks that build. |
| Fly Machines | The agent image (Fly Machines run `Dockerfile.agent`): the same sources as Docker. | Runs start from a derived image with the packages preinstalled ([Derived Fly images](#derived-fly-images)). The first run for a `PROPR_FLY_IMAGE` base manifest and package list builds it once on a build Machine; later runs, on any worker, launch the same digest with no apt step and no build Machine. A changed list or a new base image builds a new digest. With no packages configured the base image runs unchanged. When the derived image cannot be prepared, the run falls back to installing the list at Machine start from the original `PROPR_FLY_IMAGE`: the root launcher runs the `apt-get` install before it reports ready (limited to 15 minutes, `packageInstallMs`), and the start gate then gets a fresh `PROPR_FLY_BOOT_TIMEOUT`. |
| Sprites | Fly's Sprite base image, not the agent image. New Sprites run **Ubuntu 26.04 LTS (resolute)** (Fly's July 2026 change), with Ubuntu's default sources: `resolute`, `resolute-updates`, `resolute-backports` and `resolute-security`, components `main restricted universe multiverse`, amd64. Provisioning reads `/etc/os-release` and the apt sources (`sources.list`, `*.list` and deb822 `*.sources`) of every new Sprite and records what it finds, and the checks use the recorded base from then on. Ubuntu-only names such as `libssl3t64` and Ubuntu pins (`…ubuntu…`) are valid here and refused on the other runtimes. | Sprite provisioning installs the list with `apt-get` as root after the agent setup script and before the clean checkpoint, so every run on that Sprite starts with them. The apt lists stay in the checkpoint, so a repository's `.propr/setup.sh` can still `apt-get install` without its own `apt-get update`. A warm or still-provisioning replacement Sprite with a different list is retired: warm ones are deleted in the background, and the run gets a newly provisioned Sprite without waiting. A failed delete is logged and does not fail the run. An apt error fails provisioning and is reported with the run, as a failed image build is. |

Both remote runtimes log one line per install with the package list digest (`packagesDigest`), the package count and `installMs`: `Installed agent runtime packages on Sprite` when a Sprite is provisioned, and `Installed agent runtime packages in a derived Fly Machine image` when a Fly image is built (with `image`, `layerBytes`, `layerRawBytes`, `installedBytes`, `verifiedFiles` and `buildMs`). A run that reuses the image logs `Using the derived Fly Machine image for agent runtime packages` once per worker process. The fallback install at Machine start logs `Installed agent runtime packages at Fly Machine start` (or `… install failed …`). The package names are included only for lists of five or fewer. When a new Sprite reports different apt sources than the recorded ones, the worker logs `Detected the Sprite base image package sources` with the distribution. Every Fly Machines run reports compute usage measured from dispatch, before the package list is read: `wallTimeMs` covers the whole run, including any wait for the derived image or a capacity slot, and `provisioningMs` lasts until the agent starts. Each wait is also its own field: `imageWaitMs` (with packages configured) is the time spent waiting for the derived image (registry lookups, or a shared build, including one that then failed), `queueMs` (with `PROPR_FLY_MACHINES_MAX` set) the wait for a slot, and `packageInstallMs` the fallback install at Machine start.

### Derived Fly images

When packages are configured and `PROPR_FLY_IMAGE` is a `registry.fly.io/<repository>` image (by tag or digest), the worker resolves its linux/amd64 manifest and looks for the tag `registry.fly.io/<repository>:propr-packages-<hash>`. The hash covers the base manifest digest, the normalized package list and the layer recipe version, so a new agent image or a changed list gets a new tag, and an unchanged pair is reused across runs, workers and restarts. Runs use the derived image by digest. A base image named by tag is resolved again for every run, so a tag moved to a new agent image builds (or finds) the derived image for that manifest.

When the tag does not exist yet, the run that needs it builds it, and concurrent runs for the same pair in that worker process wait for that build. Only then is the list checked against the package index; a run that finds the image already built skips the check, even if the archive has since dropped a pinned version.

1. A build Machine named `propr-build-<uuid>` starts from the base image in `PROPR_FLY_APP` and runs the same `apt-get` install as root (limited to 15 minutes). It records the filesystem before and after the install and writes the difference as a gzip layer: changed and added files, and whiteouts for removed ones. Fly runtime paths, other mounts (found by mount point), apt's download caches and logs are left out. On an overlay root, regular files report their layer's device, so only directories are compared by device. It then reads the layer back. Each configured package (or a package that provides it) must be `install ok installed`, and each file `dpkg -L` lists for it must be in the layer or unchanged in the base image. Files the image's dpkg `path-exclude` rules never unpack, such as documentation in slim images, are exempt. Otherwise the build reports no layer.
2. The worker downloads the layer and checks its digest, size and uncompressed diff ID. It refuses a layer whose build reported no dpkg check, and a layer whose uncompressed size is smaller than the `Installed-Size` apt reports for the newly installed packages. Neither is pushed or cached: the run falls back to the install at Machine start, and the log says why. It then confirms deletion of the build Machine before the run creates its agent Machine, so a run never has both at once. The deletion is retried for up to 60 seconds, independent of how long the build took. If the build Machine's create response is lost, the worker looks it up by its unique name for 60 seconds and deletes it if it appears. The run falls back only once the build Machine is confirmed gone or absent. If that, or its deletion, cannot be confirmed, the run fails rather than starting its agent Machine beside it, and later runs for the same image and list delete it first.
3. The worker pushes the layer, a configuration with the extra diff ID and history entry, and a manifest with the base layers plus the new layer to the base image's repository under the tag. It authenticates with `PROPR_FLY_API_TOKEN`, which therefore needs push access to that repository; the build Machine never receives the token.

An apt failure fails the run with the end of apt's output, as a failed Docker image build does. The worker remembers it for that base manifest and package list: for ten minutes, later runs fail at once with the same error instead of each starting a build Machine. A changed package list or a new base image builds again straight away. If the image cannot be prepared for any other reason (an image outside `registry.fly.io`, a registry or transfer error, or a build Machine that produced no layer), the worker logs `Could not prepare the derived Fly Machine image` and falls back to installing at Machine start from the original `PROPR_FLY_IMAGE`, never a partly built image. For ten minutes it uses that fallback for the same pair before trying the build again. The fallback install happens in the root launcher before it reports ready, is limited to 15 minutes, and fails the run on an apt error; the list is checked against the package index before that Machine is created.

Derived tags are not deleted automatically. Remove old `propr-packages-*` tags from the agent app's repository when they are no longer needed. A worker rechecks a cached derived image's tag before reusing it once the image is five minutes old, and builds the image again if the tag is gone or names another manifest. If Fly refuses to create a Machine from a cached derived image, the worker forgets it, checks the registry once more and retries the create. While it checks or rebuilds, the run gives up its `PROPR_FLY_MACHINES_MAX` slot, since it has no Machine, and waits for a slot again before the retried create. A rebuild's build Machine can then take that slot, even with a cap of 1.

**Build Machines and capacity.** A build Machine counts against `PROPR_FLY_MACHINES_MAX`, and against the organization's Machine limit, for as long as it may exist. It takes its slot before it is created and gives it back only once Fly confirms it deleted, under the same rule as agent Machines: a deletion answered with HTTP 404, or a failed deletion after which Fly reports the Machine destroyed or unknown, counts, so a build Machine deleted outside ProPR does not hold its slot. A run waits for its own agent Machine's slot after any build it needed, so on the Free Plan a run never has a build Machine and its agent Machine at once. A build Machine whose deletion or lost create cannot be confirmed keeps its slot: the worker retries the deletion in the background every minute, and runs for the same image and list delete it first. Before its first Fly run, each worker process lists the agent app's Machines named `propr-build-*`. Each one holds a slot until it is gone. One older than any build can take (`PROPR_FLY_BOOT_TIMEOUT` plus 45 minutes) is deleted; a younger one may be another worker's build in progress, so the worker only waits for Fly to report it gone.

**Each runtime has its own accepted list.** Saving or applying a list in Settings queues the package build. On the worker, each remote runtime in use (Sprites, Fly Machines) checks the list against its own package index. It accepts the list only if the check passes. If the check fails, it keeps installing its previous list and reports the refusal. Until the build runs, remote runtimes keep the list they accepted before: a change that is still `pending` installs nothing new, and warm Sprites are retired only when the Sprites list actually changes. Docker uses the list in the last image that built, so on an instance that uses both, a failed Docker build leaves Docker on its old list while Sprites and Fly Machines use the new one. A remote runtime not in use when a list is applied drops its record. When it is selected again, it installs the applied list after checking it against its own index, never the list it accepted before. Settings shows a row per runtime in use, with its status, its active list, where it installs from and any refusal. A package state saved before this change has no per-runtime record. Remote runtimes then use the last applied list, not the desired one.

On a worker where no enabled agent runs on Docker (only Sprites or Fly Machines, so no Docker daemon), Settings does not build an image, check availability against the agent images or offer catalog suggestions. The list is reported `ready` once every remote runtime accepted it, with a note such as "Installed when Sprites are provisioned; no Docker image is built". The note is recomputed from the runtimes in use each time Settings loads, so it disappears once Docker agents are added.

Package names are checked when the list is saved, without Docker, against the package index of each runtime in use: the agent image's sources for Fly Machines, and for Docker when no Docker daemon is reachable; the recorded Sprite base for Sprites. With a reachable Docker daemon, Docker's check runs against the agent images as before. Errors name the runtime and distribution, for example `Sprites (Ubuntu 26.04 LTS (resolute)): Unknown package: postfix` or `Fly Machines (Debian 12 (bookworm)): Unknown package: libssl3t64`. ProPR fetches each suite's `InRelease` and its `Packages` index over HTTPS, checks the index against the SHA256 in `InRelease`, and caches a compact set of names and `name=version` pins per distribution in memory for four hours. A worker that uses remote runtimes and has packages configured starts loading these indexes at startup. It reads `Packages.xz` with the host's `xz`, `xzcat` or Python `lzma`, and otherwise `Packages.gz` or `Packages` where the suite publishes them. The `InRelease` signature is not verified; HTTPS and the checksum protect the download. A name that is neither a package nor provided by one (a virtual package, such as `mail-transport-agent`) is refused with `Unknown package: <name>`, and a pin the index lacks with `Unknown version: <name>=<version>`. Every bad name is listed at once. The Settings API (`validate` and `PUT`) and `propr runtime packages add|remove|apply` use this check. If an index cannot be fetched, for example on an offline host or behind a private mirror, the list is saved with the warning `could not verify availability: …`, shown in Settings and printed by the CLI. The runtime's own apt install then reports a bad name.

The worker checks the list against the runtime's index again only before a new install: before a Fly derived image build or a fallback install at Fly Machine start, and before a Sprites run or a background replacement provisions a new Sprite. A new Sprite whose reported apt sources differ from the recorded ones is checked once more against its own sources before apt runs. A name the index lacks fails the run at once, and no build or agent Machine is created (on Sprites, no Sprite is created, or the one just created is deleted before the install). A warm Sprite whose clean checkpoint was built with the same package list (the same packages digest) is reused without the check, even if a name or pinned version has since left the archive. Name syntax is checked on every read of the list. If the index cannot be fetched, the run goes ahead, and the apt install reports a bad name.

The API process decides this like the worker: from each agent's `runtime` and its own `PROPR_AGENT_RUNTIME`, or, when the API process does not set that variable, the default runtime the worker publishes at startup (the last worker to start wins). If the Docker daemon is unreachable while some agent, the instance default or the published worker default selects a remote runtime, validation falls back to the package index checks and search returns no suggestions, instead of failing.

A runtime declares support with the `supportsRuntimePackages` capability. A custom runtime that does not declare it is refused the same way while packages are configured. To install tools for one repository instead, or on a runtime that cannot apply instance packages, use `.propr/setup.sh`. Every runtime runs it before each run, so it repeats the installation every time.

## Fly Machines

Set `PROPR_AGENT_RUNTIME=fly-machines` on the worker or `runtime: fly-machines` on a Claude Code or Codex agent. Each task gets a new Machine in `PROPR_FLY_APP`. Set `PROPR_FLY_API_TOKEN` to a deploy token scoped to that app, or supply it in `FLY_API_TOKEN`. Use a dedicated agent app in the control plane’s Fly organization.

Build the unified agent image from the repository root with `fly deploy --remote-only --build-only --push --dockerfile Dockerfile.agent -a <agent-app>`. On an app with no releases, a remote build can push only by digest. Copy the manifest digest from the build output’s `pushing manifest … @sha256:` line and set `PROPR_FLY_IMAGE=registry.fly.io/<agent-app>@sha256:<digest>` on the worker. The selected image supplies both provider CLI versions.

`PROPR_FLY_REGION` selects a region. Fly chooses the placement when it is unset. `PROPR_FLY_MACHINE_SIZE` accepts `shared-cpu-<n>x` or `performance-<n>x` and defaults to `shared-cpu-2x`. `PROPR_FLY_MACHINE_MEMORY_MB` defaults to 2048. `PROPR_FLY_BOOT_TIMEOUT` sets the time allowed for creation, image pull and guest readiness in seconds (default 300).

Runs use a writable clone workspace and receive per-run credential copies. The root launcher keeps the workspace token separate and drops to `node` for the provider. Only declared refreshed credential files return to the worker. Host bind mounts and restricted-network runs are refused. For Extension Library items see [Extensions by runtime](#extensions-by-runtime). Configured instance runtime packages come preinstalled in a [derived image](#derived-fly-images); `PROPR_FLY_BOOT_TIMEOUT` does not include building it or a fallback install at Machine start. A Fly-hosted control plane exposes MCP at `http://api.process.<control-plane-app>.internal:<DASHBOARD_API_PORT>/api/mcp` (default port 4000). Set `PROPR_FLY_MCP_URL` to override the endpoint, including for a custom API process group. Elsewhere set `PROPR_AGENT_MCP_URL` without a pinned Docker network or set `API_PUBLIC_URL`. MCP uses the per-run grant token.

With an active cost cap, the worker reads new stdout bytes while the Machine runs so the shared cost guard can stop the agent. If a capture read fails, the worker retries from the last validated byte. Read failures lasting 15 seconds or a record over 16 MiB stop a capped run with an accounting error. After exit, the worker reads the remaining stdout and scans stderr for workflow reports. The shared result retains up to 1 MiB per stream. For streams collected only for results and workflow reports, reads are capped at 16 MiB per stream. For a larger capture the worker scans the retained tail and reports truncation. A truncated prefix that could contain required workflow records fails the run. Fly logs provide a best-effort live display and may omit lines. A missing capture or exit status fails the run.

With pending credentials, a SIGKILL request gives the provider at least five seconds to exit on SIGTERM before forced recovery. A graceful stop allows the clone transport to finish its snapshot. The worker copies any fallback bundle to a private temporary directory before destroying the Machine. If settlement rejects after collection, the error identifies the local recovery directory. The bundle survives release so it can be recovered manually. If workspace application fails, the clone transport reports the recovery location. If bundle retrieval fails, the worker reports the Fly app, Machine ID and guest directory. After the task exits, `PROPR_FLY_CREDENTIAL_RETENTION_SECONDS` sets the recovery window for both fallback bundles and pending credentials (default 900 seconds, or 15 minutes). When the window expires, the guest exits and Fly destroys the Machine. Any uncollected bundle is lost. A guest waiting only for credential write-back exits early on acknowledgement. If credential export or write-back fails, the worker reports the Machine and provider directory for recovery. Recover `/root/propr-run/workspace/result.bundle` from that Machine and destroy it after verifying the recovered copy.

On Fly's **Free Plan** an organization can have **3 Machines, stopped ones included**, and the control plane is one of them. Every Fly Machines agent run creates a Machine, so beside the control plane at most **2 agent runs** can run at once, fewer if other apps in the organization have Machines. A run over the organization's limit fails at creation with `System Error: Fly Machines API POST returned HTTP 422: Your organization has reached its machine limit`. On the Free Plan, prefer [Sprites](#fly-sprites), or set `PROPR_FLY_MACHINES_MAX` on the worker to the free Machine slots: 3 minus the control plane and other apps' Machines, so usually `2`. Invalid values (zero, negative, fractional or non-numeric) fail the run with `Invalid PROPR_FLY_MACHINES_MAX`.

`PROPR_FLY_MACHINES_MAX` caps the Machines one worker process keeps in `PROPR_FLY_APP` at a time (default: unlimited): agent Machines, derived-image build Machines and build Machines an earlier worker process left. A run over the cap queues until a slot is free, in arrival order, instead of failing; cancelling a queued run removes it from the queue without creating a Machine. A Machine whose deletion is retried in the background keeps its slot until the deletion succeeds or Fly reports the Machine destroyed or unknown (deleting an unknown Machine, HTTP 404, counts as success); a failed deletion is followed by that check, and a confirmed absence also ends the retries. A Machine kept for recovery (failed workspace retrieval or credential write-back, or an unconfirmed exit) keeps its slot until Fly reports it destroyed or unknown: the worker checks after the `PROPR_FLY_CREDENTIAL_RETENTION_SECONDS` window, then at most every five minutes, and a failed check keeps the slot. If a create's response is lost and the follow-up lookup does not find the Machine, the run keeps its slot while the worker looks the Machine up by name: Fly may still be creating it, so the slot is freed only by a successful lookup that finds nothing once 60 seconds have passed. A Machine found under the run's name is deleted first, since its agent never started. The cap is per worker process and does not count other workers or other apps, so with several workers split the free slots between them. Run Machines use `restart: no` and `auto_destroy: true`. The worker requests destruction as soon as it finishes retrieval. If deletion fails after collection, the worker logs the Machine ID and retries in the background while returning the collected result.

To verify a deployment, set `PROPR_FLY_LIVE_TOKEN`, `PROPR_FLY_LIVE_APP` and `PROPR_FLY_IMAGE`, then run `npx tsx --test test/flyMachinesRuntime.live.test.ts`. The suite starts one Machine at a time and exercises task completion, graceful stop, bundle retrieval and destruction.

## Fly Sprites

The Node 22 worker pins `@fly/sprites` to 0.2.5. Upstream declares Node 24 or newer. CI smoke-tests the pinned SDK on Node 22, and the live runtime suite checks service compatibility before merge. For Extension Library items see [Extensions by runtime](#extensions-by-runtime).

Set `PROPR_AGENT_RUNTIME=sprites` on the worker, or set `runtime: sprites` on an individual Claude Code, Codex, or Antigravity agent. Supply an organization token in the worker’s `PROPR_SPRITES_TOKEN` environment variable (`SPRITES_TOKEN` is also accepted). The worker defaults `SPRITES_CLIENT_SIGNALS` to `0` unless the operator sets it. Runs use the clone workspace transport. Restricted runs use the Sprite's DNS allowlist, which the worker applies before the run and clears after restoring the checkpoint. Runs reach ProPR MCP as described in [ProPR MCP from Sprites](#propr-mcp-from-sprites). See [Restricted mode on Fly Sprites](../features/execution-safety.md#restricted-mode-on-fly-sprites).

### ProPR MCP from Sprites

Automation runs (and every other run with a ProPR MCP grant) reach ProPR MCP from the Sprite in one of two ways. The worker picks one before it requests the run's grant. `PROPR_SPRITES_MCP_TRANSPORT` sets the preference:

- `auto` (the default) follows the order below: a public or explicit URL when one exists, otherwise the forward.
- `forward` always uses the SSH reverse forward, even when `PROPR_SPRITES_MCP_URL`, a public `PROPR_AGENT_MCP_URL` or `API_PUBLIC_URL` is set. ProPR MCP then never has to be reachable from the internet: the Sprite reaches it only through the worker's outbound connection. This does not disable or hide a public MCP endpoint: if the API is publicly routed with MCP enabled, OAuth clients can still reach it there. A run is refused rather than falling back to a URL when the forward is turned off (`PROPR_SPRITES_MCP_FORWARD=0`) or `PROPR_INTERNAL_API_URL` is unusable. Any other value refuses Sprites runs that need ProPR MCP, so a typo never silently picks a public URL.

With `auto`:

1. **A public or explicit URL, used directly.** That is `PROPR_SPRITES_MCP_URL` when set (for example a public ProPR origin or a gateway in front of the API). Otherwise it is a public HTTPS `PROPR_AGENT_MCP_URL` (without `PROPR_AGENT_DOCKER_NETWORK`) or `API_PUBLIC_URL` + `/api/mcp`. This covers ProPR hosted on Fly and Plus installations with the hosted UI tunnel. A public HTTPS URL is preferred when you have one: it needs no sshd in the Sprite and no worker-held connection.
2. **Otherwise, a per-run SSH reverse forward (`ssh-reverse-forward`).** This is for self-hosted instances behind NAT with no public URL. The worker already connects out to the Sprite, and the forward carries MCP back over that path, so nothing is exposed publicly:
   - For each run, the worker generates an ephemeral ed25519 client key and an sshd host key, in memory only. Neither is logged or kept after the run.
   - Before the agent starts, the worker starts an sshd in the Sprite. It is bound to `127.0.0.1:39022` only and authorizes just that key for the `propr-mcp` user (`restrict,port-forwarding,permitlisten="127.0.0.1:39080"`). Password, keyboard-interactive and host-based auth are off, and so are sessions, shells, TTYs, agent, X11, tunnel and local forwarding.
   - The worker reaches that sshd only through the Sprites API proxy (`proxyPort`), checks the host key it generated, and asks for one remote listener on `127.0.0.1:39080`. Each connection to that listener is relayed to the internal API host and port in `PROPR_INTERNAL_API_URL` (default `http://api:4000`), and only there. A connection to the API that does not complete within 10 seconds is refused, and closing the forward also closes connections still being set up.
   - The relay passes raw bytes, so requests reach the API with the agent's `Host: 127.0.0.1:39080`. That is why `PROPR_INTERNAL_API_URL` must be a plain `http://` URL on a loopback or private address (an IP in 127/8, 10/8, 172.16/12, 192.168/16, 100.64/10, 169.254/16, `::1` or `fc00::/7`), `localhost`, a single-label name such as the Compose service `api`, or a `.internal`/`.local` name. There the `Host` header does not route requests. An `https://` or public target, where a vhost- or SNI-routed server would answer 404 or 421, refuses the forward with a message saying what to set.
   - The agent's ProPR MCP config names `http://127.0.0.1:39080/api/mcp`, and it still has to present its per-run grant token. The runtime selects the forward from that URL itself, not from a separate flag that every rebuilt tool policy would have to copy. A Sprites run whose ProPR MCP URL is some other loopback address (for example `http://127.0.0.1:4000`) is refused with an explicit error, because nothing inside the Sprite listens there. Responses are relayed as plain byte streams, so streamed and SSE responses work. The address is loopback, so a restricted Sprite's network policy gets no MCP host entry.
   - The forward is torn down with the run: after success, failure, cancellation or timeout, and when a lost connection cannot be reattached. The worker asks the Sprite to stop the sshd in the background, without holding the run's slot for it; the Sprite reset to its clean checkpoint stops it anyway and removes the keys. If the forward drops mid-run, the worker reconnects. Before each attempt it ends the `propr-mcp` user's stale sessions over the Sprites exec API (`mcp-forward.sh reset-sessions`) and waits until `127.0.0.1:39080` is free: after a half-open proxy path the old session would otherwise keep the listener and every new forward would fail with "address in use". sshd itself drops a silent client after 10 seconds (`ClientAliveInterval 5`, `ClientAliveCountMax 2`). The worker keeps trying for at least five attempts with backoff and at least 30 seconds, three times that timeout. If every attempt fails, the run fails with a `MCP_TRANSPORT_LOST` error instead of leaving tool calls hanging.
   - The task log records the transport (`ProPR MCP transport: ssh-reverse-forward`).

   Provisioning installs `openssh-server` when the Sprite base image lacks it. It keeps the packaged system sshd from starting or running at boot and creates the shell-less `propr-mcp` user. Set `PROPR_SPRITES_MCP_FORWARD=0` (or `false`, `off`, `no`) to turn the forward off. The value is parsed strictly: anything other than true/false values (`1`/`0`, `true`/`false`, `on`/`off`, `yes`/`no`), such as `disabled` or `none`, refuses Sprites runs that need ProPR MCP with `Invalid PROPR_SPRITES_MCP_FORWARD`, so a misspelling never leaves the forward on.
3. **Otherwise the run is refused** before a grant is issued (`MCP_NETWORK_UNAVAILABLE`), with what to configure. This happens when the forward is off and no public URL is set, or when `PROPR_INTERNAL_API_URL` is not a plain `http://host:port[/path]` URL on a loopback, private or internal address.

`get_agent_run_admission` and `propr admission` show the transport the preference selects.

Fly Machines runs reach MCP over Fly's private network instead and never use the forward.

Workers sharing the installation’s Redis database share one Sprite pool limit. Set `PROPR_SPRITES_MAX` on every worker (default 2; the Free plan allows 3). Use the same Sprites organization on all workers. Each new machine reserves capacity before creation. At capacity, a run waits for a clean Sprite for up to `PROPR_SPRITES_QUEUE_TIMEOUT` minutes (default 10). Idle machines can be released to make room on another worker.

Workers persist the deployment marker under the shared `DATA_DIR` and rebuild missing Redis inventory from the provider before admitting capacity. For the inventory format upgrade, stop the previous workers together and retain Redis until the new worker has saved the existing deployment marker. Installations sharing a Redis database must set distinct `PROPR_INSTANCE_ID` values, consistent across each installation’s API and workers. Workers renew leases every five seconds. After a crash, leases expire after three minutes, and the machine continues to count toward capacity until deletion is confirmed. On startup and every five minutes, workers check the deployment’s machines and remove unleased ones older than `PROPR_SPRITES_ORPHAN_AGE` (minutes, default 30). View counts in `propr status`, Settings → Agent runtime packages, or the `get_agent_run_admission` MCP tool. Run compute usage reports capacity wait separately as `queueMs` and includes the provisioning and checkpoint restore times for the clean Sprite supplied to that run. A warm checkout reports zero provisioning time.


The worker creates a privately named Sprite for each concurrent run and reuses restored Sprites within its process. Provisioning installs the versions pinned in `Dockerfile.agent`, any configured [runtime packages](#runtime-packages) and the run's package MCP servers, then takes a clean checkpoint before uploading any run data. The clone transport holds its repository token separately while the setup hook and provider entrypoint run as the unprivileged `node` user. The worker reads provider credentials after acquiring the Sprite, immediately before uploading the run payload. The agent timeout starts at launch. Each provisioning attempt has a separate 47-minute deadline (up to 20 minutes for agent setup, 15 for runtime packages and about 11 for package MCP servers). Each CLI uses a writable copy of its read-only source. The worker collects only declared refreshable files through the launcher export and commits them through the broker.

If the launch connection drops, the worker attempts to reattach once to observe process exit. The pinned SDK exposes no output resume offset. A reattached run reports incomplete output after workspace retrieval, and its workflow reports are marked unobserved.

Release restores the entire checkpoint after credential write-back and workspace result retrieval, including failed and stopped runs. If result retrieval fails before the worker verifies a local Git ref, cleanup keeps the Sprite out of the pool and reports its name and result directory for recovery. A restore failure causes the worker to destroy the Sprite and provision a replacement. A restarted worker creates its own Sprites. On graceful shutdown the worker drains its jobs and deletes its idle Sprites. Standalone callers should await `runtime.close()` after releasing their runs.

After a crash or failed deletion, use `sprite list --prefix propr-` in the worker’s Sprites organization. Match each candidate’s exact name to the stopped worker’s `Worker created Sprite` log entry and check its job errors for bundles kept for recovery. If the creating worker is unknown, drain and stop all ProPR workers sharing the organization before reaping their Sprites. Once any needed result is recovered, delete the confirmed orphan with `sprite destroy -s <exact-name>`. [Sprites CLI reference](https://docs.sprites.dev/working-with-sprites/#managing-sprites)

## Extensions by runtime

| What the agent gets | Docker | Sprites | Fly Machines |
| --- | --- | --- | --- |
| Skills, commands, agents and instruction files in the provider config directory | Yes, in the per-run credential copy | Yes, in the uploaded credential copy | Yes, in the Machine's credential copy |
| Repository skills, `AGENTS.md` and `CLAUDE.md` | Yes, with the worktree | Yes, with the clone | Yes, with the clone |
| Library skill bundles | Yes, read-only mount | Yes, uploaded read-only | Yes, as read-only Machine files |
| Library URL MCP servers | Yes | Yes | Yes |
| Library package (stdio) MCP servers | Yes, read-only mount | Yes, installed in the clean checkpoint | Yes, installed at Machine start |
| Operator catalog stdio servers (`catalogMcp`) | Yes | No: dropped with a note when auto-applied, run refused when added explicitly | No: dropped with a note when auto-applied, run refused when added explicitly |
| ProPR MCP | Private network or reachable URL | Reachable URL or SSH reverse forward | Reachable URL |

Library skill bundles appear at `/opt/propr/extensions/<bundle id>/` in every runtime, and the run prompt points the agent at each `SKILL.md`. Docker bind-mounts the worker's validated staging directory. Sprites and Fly Machines receive the same files, checked against the bundle digest the run resolved, in the run's upload: root-owned and read-only for the agent, and gone when the Sprite is restored or the Machine destroyed, like the per-run credential copies.

URL MCP servers reach the run through the ProPR extension gateway with the run's grant token, so the run needs only the gateway. On Sprites and Fly Machines the gateway URL is derived from the run's reachable ProPR MCP URL (`PROPR_SPRITES_MCP_URL` or `PROPR_FLY_MCP_URL`, else `PROPR_AGENT_MCP_URL` without a pinned network, else `API_PUBLIC_URL`) by replacing `/api/mcp` with `/api/extensions/mcp`. It is derived only for a run that carries URL servers, so a run with only skills or package servers does not depend on the MCP URL's path. On Sprites without a public URL, the run's ProPR MCP transport is the SSH reverse forward (see [ProPR MCP from Sprites](#propr-mcp-from-sprites)), and the gateway is `http://127.0.0.1:39080/api/extensions/mcp` on the same forward: the relay targets `PROPR_INTERNAL_API_URL`, so the gateway path reaches the API with no extra listener. The worker opens the forward for such a run even when it has no ProPR MCP grant. A restricted Sprite allows the gateway host beside the ProPR MCP host; over the forward it needs no host, since the listener is loopback. The gateway checks each upstream server against the run's network policy, as for Docker. With no reachable URL and the forward off (`PROPR_SPRITES_MCP_FORWARD=0`), or a URL whose path does not end in `/api/mcp` (for example a proxy with another path), URL servers count as unsupported on that runtime: auto-applied ones are dropped with a note and explicitly added ones refuse the run.

Package servers are installed and verified on the worker first, on every runtime: the same registry, exact version, integrity value and no lifecycle scripts (see [Local package servers](../features/agent-extensions.md#local-package-servers)). Docker bind-mounts that install. Sprites and Fly Machines replay it inside the sandbox: they receive the worker install's `package.json` and `package-lock.json`, run `npm ci --ignore-scripts` from the same registry, so every dependency is checked against the integrity value in the lock file, check that the lock pins the package at its stored integrity value and that the installed package reports the pinned version, and make the result root-owned and read-only at `/opt/propr/packages/<key>`. The servers then run next to the agent through the same stdio bridge as on Docker, with the same plain variables, secrets passed by environment name only, and the run's network policy.

- **Sprites** install the run's package servers while provisioning a Sprite, before its clean checkpoint, so each run restored from it has them. The warm pool keeps idle Sprites per digest of the installed package-server set: a run takes an idle Sprite built for exactly its set, otherwise it provisions one. Idle Sprites built for other sets stay warm for the runs that need them, so runs with and without package servers, or with different sets per repository, each reuse their own Sprites. `PROPR_SPRITES_MAX` still bounds the total: at the cap, the least recently used idle Sprite built for another set is deleted to make room. A background replacement for a discarded Sprite is built with that Sprite's set. A failed install fails provisioning with the end of npm's output.
- **Fly Machines** install them at Machine start, as root, before the agent and before the start gate opens, within a 10-minute limit. While the Machine reports the install, the boot deadline extends up to that limit, and the agent gets a full boot window once the install finishes. A failed or timed-out install fails the run with the end of npm's output and destroys the Machine without starting the agent. A run without package servers has no install step. The whole Machine configuration, including skill files and lock files, must stay under 4 MiB; a larger one is refused before the Machine is created.
- A package server whose verified install has no `package-lock.json` or `package.json`, or one larger than 2 MiB, cannot be replayed in the sandbox. An auto-applied one is left out of the run with a note; an explicitly added one refuses the run. The message says which file is missing or too large.
- On both, the install time is reported as `packageServerInstallMs` in the run's compute usage (a warm Sprite reports none). On Fly Machines, as for runtime packages, `wallTimeMs` runs from dispatch and `provisioningMs` lasts until the agent starts, so it includes the install. Runtime packages are installed before the package servers, so a server can rely on them. The sandbox must reach the npm registry: a private mirror set with `PROPR_EXTENSION_NPM_REGISTRY` must be reachable from Sprites and Fly Machines too.

Operator catalog stdio servers run an executable that must already exist in the run's image, which Sprites and Fly Machines do not provide. The registry refuses only the classes a runtime cannot run:

- An auto-applied item the runtime cannot run is dropped for that run. The run's `extensions.resolved` event lists it as skipped with reason `agent_runtime_unsupported`, and the issue or pull request comment carries a note naming it. The run continues.
- An explicitly added item the runtime cannot run refuses the run with an `AgentRuntimeCapabilityError` (`skills`, `remote_mcp`, `package_mcp` or `catalog_mcp`) that names the item.

A custom runtime declares the classes it applies in `capabilities.extensions` (`skills`, `remoteMcp`, `packageMcp`, and optionally `catalogMcp`, which defaults to `packageMcp`). Without that field, Docker applies every class and other runtimes none. A custom runtime without `packageMcp` keeps the rule above for package servers.

Each run that applies library items logs one line, `Extension Library items applied to this run`, with the runtime, library revision, an `extensionDigest` of the applied items, the counts `skills`, `urlServers`, `packageServers` and `catalogStdioServers`, and the `packageServersDigest`. Sprites log `Installed package MCP servers on Sprite` and Fly Machines `Installed package MCP servers at Fly Machine start`, with the same digest and the install time.

## Container Configuration

The worker launches the unified agent image with a prepared worktree, a generated container name, the selected type's credential mount, and any agent-level environment variables. Containers are removed after execution with `--rm`, run with stdin enabled, and use `/home/node/workspace` as the working directory.

Docker starts an init process as PID 1 with `--init`. It reaps orphaned children, forwards signals to the entrypoint, and returns its exit status. When the entrypoint execs the agent CLI, the CLI receives those signals directly.

Most entrypoints start as root so they can prepare runtime directories or fix container-local ownership, then drop to the `node` user before running the CLI. Entrypoints also mark Git directories as safe, install the `gh` wrapper when present, and emit diagnostics that are captured with the task logs.

Existing-account credential and launcher paths must be absolute host paths. Shell shortcuts such as `~` and `$HOME` are not expanded by launcher configuration. Direct-login accounts instead save a portable `~/.propr/agent-credentials/<agent-id>/…` path that ProPR maps to its managed host root automatically.

## Timeouts And Loop Limits

Timeouts prevent runaway jobs and make failures visible in task state. Defaults differ by agent:

| Agent | Timeout variable | Default | Loop variable | Default |
| --- | --- | ---: | --- | ---: |
| Claude Code | `CLAUDE_TIMEOUT_MS` | `86400000` (24 hours) | `CLAUDE_MAX_TURNS` | `1000` |
| Codex | `CODEX_TIMEOUT_MS` | `86400000` (24 hours) | Not used | N/A |
| Antigravity | `ANTIGRAVITY_TIMEOUT_MS` | `86400000` (24 hours) | Not used | N/A |
| OpenCode | `OPENCODE_TIMEOUT_MS` | `86400000` (24 hours) | Not used | N/A |
| Mistral Vibe | `VIBE_TIMEOUT_MS` | `86400000` (24 hours) | `VIBE_MAX_TURNS` | `1000` |

These task-execution defaults are shared across all coding agents and match the shipped `.env.example`. Planner keyword extraction and semantic relevance scoring default to 60 minutes per call and can be adjusted with `CONTEXT_ANALYSIS_TIMEOUT_MS`.

When an implementation run reaches its execution timeout or maximum turn limit, ProPR preserves any workspace changes produced before the interruption. If changes exist, it commits and pushes them, opens the issue PR or updates the existing follow-up PR, and marks the result as potentially incomplete with the agent's last available summary and explicit remaining-work guidance. Other execution errors still fail normally, and an interrupted run with no changes has nothing to publish.

When tuning these values, consider repository size, task complexity, provider rate limits, worker concurrency, and host CPU and memory. Increase timeouts only after checking task and worker logs; a timeout may indicate missing context, provider slowness, a task that should be split, or an agent loop.

## Security Boundary

The runtime should preserve these boundaries:

- Keep git finalization outside the agent.
- Mount only the workspace, the shared git directory, and required credential directories.
- Avoid further host filesystem mounts. The shared git directory already exposes every cloned repository to the agent, so separate repositories with different trust levels onto separate stacks.
- Keep credential directories scoped to the deployment user.
- Monitor container CPU, memory, and duration.
- Treat `--dangerously-*` CLI flags as acceptable only because Docker is the outer isolation boundary.

#### Agent `envVars` redaction

Agent `envVars` values are treated as secrets at every administrative output boundary. `GET`/`POST /api/config/agents`, `propr agent list`/`add` (text and `--json`) and the MCP agent tools return only the variable names; each value is the fixed marker `[REDACTED]` (or the field is omitted), never a prefix, length, hash or encoding of the real value. Agent containers still receive the stored values. When a client saves the agent list back, a `[REDACTED]` value keeps the stored value for that variable on the same agent id; a new value replaces it, and a removed key deletes it. A marker with no stored value is rejected with `400`.

### Network Egress

Containers run on Docker's default bridge network with `--security-opt no-new-privileges` and `--cap-add CHOWN`, so outbound network access is unrestricted in the default `open` mode. The `.propr/setup.sh` hook runs under that same Docker privilege boundary and cannot use sudo to install system packages.

In `restricted` mode (instance setting `agent_network_mode`, or `network.mode` in `.propr/workflow.yml`), the Docker executor starts a per-container allowlist proxy in the worker process on a Unix socket under `PROPR_EGRESS_SOCKET_DIR`, replaces the container's network (whatever `docker run` named, or the default bridge) with `--network none`, mounts the socket directory read-only at `/run/propr-egress`, and sets `HTTP_PROXY`/`HTTPS_PROXY`, `NO_PROXY` and Git's `http.proxy`. A bridge started by the container wrapper exposes the socket as `127.0.0.1:3128` before setup hooks and the agent run. The proxy resolves DNS on the worker and refuses hosts outside the allowlist with `403`, and chains allowed connections through the worker's own `HTTPS_PROXY`/`HTTP_PROXY` when set; it closes when the container's `docker run` exits. Native goal sessions, which spawn `docker run` directly, get the same proxy for the life of that process. No privileged flag or extra capability is used. See [Restricted network mode](../features/execution-safety.md#restricted-network-mode).

Provider connectivity failures in open mode usually come from the host network, DNS, proxy settings, provider availability, or an external firewall. In restricted mode, check the task timeline's **Restricted Network** event for denied hosts first.

## Monitoring And Debugging

Useful signals:

- Task logs in the Web UI
- Worker logs with correlation IDs
- Container exit code
- Agent stdout and stderr
- Session or conversation IDs when available
- Duration, timeout state, token usage, and usage-limit state
- Compute usage per run (wall time, CPU-seconds, peak/average memory, compute cost), sampled from the container cgroup; see [Compute Usage](./coding-agent-integration.md#compute-usage) for `PROPR_COMPUTE_USAGE_SAMPLE_MS` and the `PROPR_COMPUTE_RATES` rate table

For direct Docker inspection:

```bash
docker ps
docker logs <container>
docker inspect <container>
```

## Common Issues

### Authentication Issues

For a direct-login account, check that the managed credential root is mounted and that the agent's generated path is still `~/.propr/agent-credentials/<agent-id>/…`. For reused host credentials, check that the CLI is authenticated and the expected directory is mounted into the agent's container path. For example, Claude Code expects its selected directory at `/home/node/.claude`, while Codex expects its selected directory at `/home/node/.codex`.

### Docker Permission Issues

Check that the deployment user can access Docker and that the launcher or worker can start sibling containers. If a container can start but cannot edit the worktree, inspect bind-mount ownership and the entrypoint diagnostics.

### Network Issues

In the default `open` mode egress is unrestricted: check the host network, DNS, proxy configuration, external firewall rules, and provider status. In `restricted` mode, the task timeline's **Restricted Network** event lists every denied host; add a needed host to `network.allow` in `.propr/workflow.yml` or to the instance `agent_network_allow` setting. A container log line `ProPR restricted network: egress proxy socket ... is missing` means the Docker daemon cannot see the worker's `PROPR_EGRESS_SOCKET_DIR`; mount it at the same path, or set `HOST_PROPR_EGRESS_SOCKET_DIR` to the Docker host path.

### Timeout Issues

Check worker logs, task logs, provider latency, and model routing before increasing timeout values. Persistent timeouts often mean the prompt is too broad, context is missing, or the provider is slow or rate limited.

## Agent-Specific Configuration

### Claude Code

Claude Code uses `Dockerfile.agent`, `scripts/claude-entrypoint.sh`, and the `propr/agent` image. The host credential directory is configured with `CLAUDE_CONFIG_PATH` or the agent config path and is mounted at `/home/node/.claude`.

Common settings:

```bash
AGENT_DOCKER_IMAGE=propr/agent:latest
CLAUDE_CONFIG_PATH=/home/your-user/.claude
CLAUDE_MAX_TURNS=1000
CLAUDE_TIMEOUT_MS=86400000
```

The entrypoint checks for `/home/node/.claude/.credentials.json`, creates expected Claude subdirectories such as `todos`, `projects`, `shell-snapshots`, and `statsig`, and prepares `/home/node/.claude/projects/home-node-workspace` for the mounted workspace.

For implementation tasks, the worker invokes Claude Code with the prompt on stdin:

```bash
claude -p - --no-session-persistence [--model <id>] --max-turns N --output-format stream-json --verbose --dangerously-skip-permissions
```

`--max-turns` comes from `CLAUDE_MAX_TURNS`. The worker captures Claude's stream JSON output, session ID, conversation log, and token usage when available.

### Codex

Codex uses `Dockerfile.agent`, `scripts/codex-entrypoint.sh`, and the `propr/agent` image. The host credential directory is configured with the agent config path, commonly from `HOST_CODEX_DIR`, and is mounted at `/home/node/.codex`.

Common settings:

```bash
HOST_CODEX_DIR=/home/your-user/.codex
CODEX_TIMEOUT_MS=86400000
CODEX_STREAM_TRANSPORT=websocket
CODEX_STREAM_IDLE_TIMEOUT_MS=1800000
CODEX_STREAM_MAX_RETRIES=5
```

The entrypoint checks for `/home/node/.codex/config.toml`, prepares `sessions` and `rules`, and avoids recursively changing bind-mounted workspace ownership. Codex runs as:

```bash
codex exec --ephemeral --json --dangerously-bypass-approvals-and-sandbox --config features.multi_agent=false --skip-git-repo-check --cd /home/node/workspace -
```

Codex 0.169 and later ignore an untrusted workspace's `.codex/config.toml` and project MCP servers. Codex 0.168 and earlier saved trust for `/home/node/workspace` in the mounted `config.toml` on any `--dangerously-bypass-approvals-and-sandbox` run. To keep that behaviour, the entrypoint adds `--trust` to `codex exec` when the installed CLI offers the flag. `--trust` saves the same entry and still respects a workspace the operator has marked `untrusted`. Repository inspection and runs with an exclusive extension MCP catalog pass `--ignore-user-config` and stay untrusted. Goal runs through `codex app-server` need no flag: starting the goal's thread saves the same entry before the repository configuration is read, and a workspace marked `untrusted` stays untrusted.

When a model is selected, ProPR adds `--model <id>`. By default, ProPR selects a WebSocket-capable OpenAI provider with a 30-minute stream idle timeout so long, quiet turns are not pinned to a single HTTP response body. Set `CODEX_STREAM_TRANSPORT=sse` when WebSockets are unavailable or `CODEX_STREAM_TRANSPORT=inherit` to preserve a custom provider from the mounted Codex configuration. Codex emits NDJSON events that ProPR parses into logs, result text, session metadata, and token usage; reconnect notices remain visible without making a later successful turn fail.

### Antigravity

Antigravity uses `Dockerfile.agent`, `scripts/antigravity-entrypoint.sh`, and the `propr/agent` image. The runtime resolves `ANTIGRAVITY_CONFIG_PATH` or the agent config path and mounts the selected host directory at `/home/node/.gemini`. If the configured path ends in `.antigravity` and a sibling `.gemini` directory exists, ProPR uses that `.gemini` directory for credentials.

Common settings:

```bash
HOST_ANTIGRAVITY_DIR=/home/your-user/.gemini
ANTIGRAVITY_CONFIG_PATH=/home/your-user/.gemini
ANTIGRAVITY_TIMEOUT_MS=86400000
```

The entrypoint prepares Antigravity runtime directories under the mounted config path and looks for auth, OAuth, credential, or token files. The agent CLI is `agy`; ProPR passes the selected model with `--model <id>` after translating ProPR model IDs into Antigravity CLI model IDs.

ProPR also passes `--print-timeout` set to the run's timeout (`ANTIGRAVITY_TIMEOUT_MS` for tasks). From Antigravity CLI 1.5.0, a run that hits that deadline exits with code `3`, prints an `AGY_ERROR` line and writes `[agy] print timeout after ...` to stderr. ProPR records such a task as timed out, with the CLI's explanation as the error, and does not accept the partial answer of an analysis run.

### OpenCode

OpenCode uses `Dockerfile.agent`, `scripts/opencode-entrypoint.sh`, and the `propr/agent` image. The primary config mount is commonly `HOST_OPENCODE_XDG_DIR=/home/your-user/.config/opencode`, mounted at `/home/node/.config/opencode`.

Common settings:

```bash
HOST_OPENCODE_XDG_DIR=/home/your-user/.config/opencode
HOST_OPENCODE_DATA_DIR=/home/your-user/.local/share/opencode
OPENCODE_TIMEOUT_MS=86400000
AGENT_DOCKER_IMAGE=propr/agent:latest
```

The entrypoint sets `OPENCODE_CONFIG_DIR=/home/node/.config/opencode` and prepares XDG data and state directories. OpenCode runs in JSON mode through the OpenCode adapter (`scripts/opencode-run.sh` with `--format json`). ProPR passes the selected model with `--model <id>` and parses OpenCode responses back into the shared agent result shape.

#### Host Setup

Install OpenCode on the host and initialize the directories ProPR can mount:

```bash
curl -fsSL https://opencode.ai/install | bash
# or: npm install -g opencode-ai

mkdir -p ~/.config/opencode ~/.local/share/opencode
opencode --version
opencode auth login
```

OpenCode's config location is `~/.config/opencode`; configure OpenCode agents with that path. The built-in free models run without provider login — operators only need credentials for OpenCode Go or any other authenticated provider they configure.

#### Auth Data

OpenCode stores provider auth in `~/.local/share/opencode/auth.json`. When `HOST_OPENCODE_DATA_DIR` is set in the worker environment, ProPR mounts that host directory into OpenCode agent containers at `/home/node/.local/share/opencode`, read-write so the CLI can refresh auth metadata. When it is unset, ProPR infers the matching host data path for default config paths like `/home/your-user/.config/opencode` and mounts it when the directory exists.

Without either data mount, make credentials available another way:

- Pass provider API keys as agent `envVars`.
- Copy `auth.json` under the mounted config tree and point `XDG_DATA_HOME` at it in the agent `envVars` (`XDG_DATA_HOME=/home/node/.config/opencode/xdg-data`). Re-sync the file after changing providers or refreshing OpenCode auth:

```bash
mkdir -p ~/.config/opencode/xdg-data/opencode && cp ~/.local/share/opencode/auth.json ~/.config/opencode/xdg-data/opencode/auth.json
```

By default the container receives `XDG_CONFIG_HOME=/home/node/.config` and `XDG_DATA_HOME=/home/node/.local/share`; the `envVars` override applies only for copied file-based auth. Authentication failures usually mean the configured config path does not point at the host's initialized OpenCode directory, `HOST_OPENCODE_DATA_DIR`/`XDG_DATA_HOME` does not point at mounted auth data, or the selected provider API key is missing or expired.

#### Model-ID Translation

ProPR catalog IDs for OpenCode carry the `opencode-` prefix, for example `opencode-big-pickle`. ProPR converts these back to OpenCode's native `provider/model` syntax at execution time (`opencode-big-pickle` becomes `opencode/big-pickle`) and strips only the internal `opencode:` routing prefix, so provider-qualified model IDs remain intact. The OpenCode model list is dynamic: run `opencode models` on the host after changing auth providers, then register any desired authenticated provider IDs (for example `opencode-openai/gpt-5.5`) on the agent's supported models. ProPR keeps only the built-in free OpenCode models as defaults and does not add authenticated provider models automatically. See [Agents and Models](../features/agents-and-models.md) for the catalog and label formats.

### Mistral Vibe

Mistral Vibe uses `Dockerfile.agent`, `scripts/vibe-entrypoint.sh`, and the `propr/agent` image. The host config directory is configured with `VIBE_CONFIG_PATH` or the agent config path, commonly from `HOST_VIBE_DIR`, and is mounted at `/home/node/.vibe` when usable.

Common settings:

```bash
HOST_VIBE_DIR=/home/your-user/.vibe
VIBE_CONFIG_PATH=/home/your-user/.vibe
VIBE_TIMEOUT_MS=86400000
VIBE_MAX_TURNS=1000
VIBE_ANALYSIS_TIMEOUT_MS=1800000
MISTRAL_API_KEY=...
```

Vibe can use either a valid Vibe config directory or `MISTRAL_API_KEY`. The entrypoint copies config into a per-run runtime home, sets `HOME` and `VIBE_HOME` to that runtime directory, loads `.env` defaults from the Vibe home, and sets `VIBE_ACTIVE_MODEL` when ProPR selects a model.

Implementation prompts are written to a temporary prompt file and passed through the Vibe prompt-file runner so the prompt does not need to appear directly in process arguments. Analysis runs can use read-only config mode and a shorter `VIBE_ANALYSIS_TIMEOUT_MS`.
