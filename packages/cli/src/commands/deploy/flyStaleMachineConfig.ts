/**
 * Keys a redeploy has to remove from the live control-plane Machine.
 *
 * `flyctl deploy` builds the new Machine config by `json.Unmarshal`-ing the
 * machine_config JSON into a copy of the live config (flyctl
 * internal/appconfig/machines.go updateMachineConfig → config.ParseConfig).
 * Keys missing from the JSON keep their live values, and `containers` entries
 * are decoded into the live entry at the same index, so a container keeps
 * fields the new layout dropped. A Machine created with the earlier temp_dir
 * layout kept its top-level `volumes` and per-container `mounts` this way, and
 * the docker sidecar crash-looped on `cannot stat /upper/dev/vdb/propr_shared`.
 *
 * The machine_config JSON therefore sends an explicit `[]` for both keys (an
 * empty array does clear a Go slice), and the flyctl target compares the
 * Machine with the plan after deploying; if anything stale survived, it
 * replaces the Machine and keeps the volume (flyDeployRunner.ts).
 */

export interface LiveMachineConfig {
  volumes?: unknown;
  containers?: unknown;
}

function nonEmptyArray(value: unknown): value is unknown[] {
  return Array.isArray(value) && value.length > 0;
}

function containerName(value: unknown): string | undefined {
  const name = (value as { name?: unknown } | null)?.name;
  return typeof name === "string" ? name : undefined;
}

/**
 * Human-readable list of the `volumes` and container `mounts` that `live`
 * has and `planned` (the machine_config JSON) does not; empty when the
 * Machine matches the plan for those keys.
 */
export function staleMachineConfigKeys(live: LiveMachineConfig | undefined, planned: LiveMachineConfig): string[] {
  if (!live) return [];
  const stale: string[] = [];
  if (nonEmptyArray(live.volumes) && !nonEmptyArray(planned.volumes)) {
    const names = live.volumes.map((v) => containerName(v) ?? "?").join(", ");
    stale.push(`volumes (${names})`);
  }
  const plannedContainers = Array.isArray(planned.containers) ? planned.containers : [];
  const liveContainers = Array.isArray(live.containers) ? live.containers : [];
  for (const container of liveContainers) {
    const mounts = (container as { mounts?: unknown } | null)?.mounts;
    if (!nonEmptyArray(mounts)) continue;
    const name = containerName(container);
    const match = plannedContainers.find((c) => containerName(c) === name) as { mounts?: unknown } | undefined;
    if (!nonEmptyArray(match?.mounts)) stale.push(`mounts of container ${name ?? "?"}`);
  }
  return stale;
}
