import type { OrchestratorModule } from '../../orchestrator/index.js';

/** Docker's verbose manifest format covers both single manifests and indexes.
 * Ignore attestations/unknown platforms; never infer ARM support from a tag. */
export function manifestPlatforms(value: unknown): string[] {
  const found = new Set<string>();
  const visit = (entry: unknown): void => {
    if (Array.isArray(entry)) { entry.forEach(visit); return; }
    if (!entry || typeof entry !== 'object') return;
    const row = entry as Record<string, unknown>;
    const platform = row.platform as Record<string, unknown> | undefined;
    if (platform?.os === 'linux' && ['amd64', 'arm64'].includes(String(platform.architecture))) {
      found.add(`linux/${platform.architecture}`);
    }
    if (row.Descriptor) visit(row.Descriptor);
    if (row.manifests) visit(row.manifests);
  };
  visit(value);
  return [...found];
}

export function selectSetupImagePlatform(platforms: readonly string[], architecture: string, agent: boolean): string {
  const native = architecture === 'aarch64' || architecture === 'arm64' ? 'linux/arm64'
    : architecture === 'x86_64' || architecture === 'amd64' ? 'linux/amd64' : undefined;
  if (!native) throw new Error(`Unsupported Docker engine architecture: ${architecture}`);
  // The released agent is AMD64. Its ARM64 compatibility must be independently
  // qualified before changing this policy. Docker Desktop supplies emulation.
  const selected = agent ? 'linux/amd64' : native;
  if (!platforms.includes(selected)) throw new Error(agent
    ? 'Image does not declare the required linux/amd64 platform. ARM64 agent images, including source builds, are not yet qualified; build or select an AMD64 agent image.'
    : `Image does not declare the required ${selected} platform`);
  return selected;
}

export async function inspectSetupEngineArchitecture(orch: OrchestratorModule, signal?: AbortSignal): Promise<string> {
  const engine = await orch.dockerAsync(['info', '--format', '{{.Architecture}}'], { timeout: 10_000, signal });
  signal?.throwIfAborted();
  if (engine.status !== 0) throw new Error('Docker Desktop engine architecture could not be verified');
  return (engine.stdout ?? '').trim();
}

export async function inspectSetupImagePlatform(
  orch: OrchestratorModule, image: string, agent: boolean, local: boolean, signal?: AbortSignal, architecture?: string,
): Promise<string> {
  const engineArchitecture = architecture ?? await inspectSetupEngineArchitecture(orch, signal);
  const result = await orch.dockerAsync(local
    ? ['image', 'inspect', '--format', '{"Os":{{json .Os}},"Architecture":{{json .Architecture}}}', image]
    : ['manifest', 'inspect', '--verbose', image], { timeout: 30_000, signal });
  signal?.throwIfAborted();
  if (result.status !== 0) throw new Error(`Cannot verify image platforms for ${image}: ${result.stderr || result.error?.message || 'Docker inspection failed'}`);
  let value: unknown;
  try { value = JSON.parse(result.stdout ?? ''); }
  catch { throw new Error(`Docker returned invalid platform metadata for ${image}`); }
  const row = value as { Os?: string; Architecture?: string };
  const platforms = local ? (row.Os === 'linux' ? [`linux/${row.Architecture}`] : []) : manifestPlatforms(value);
  return selectSetupImagePlatform(platforms, engineArchitecture, agent);
}
