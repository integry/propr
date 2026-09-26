import { describeVisualPreviewOriginalCapacity, githubInlineEligibility, MIB, resolveGitHubAttachmentCapacity, resolveVisualPreviewOriginalAssetCapacity, resolveVisualPreviewOriginalCapacity, VISUAL_PREVIEW_CONTENT_TYPES, type GitHubAttachmentCapacity, type GitHubInlineEligibility, type VisualPreviewOriginalAssetCapacity, type VisualPreviewOriginalCapacity } from '@propr/shared';
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { VisualPreviewSettings, VisualPreviewType } from '../config/configManager.js';
import { createHooklessGit } from '../git/hooklessGit.js';
import {
  VISUAL_PREVIEW_DIRECTORY,
  VISUAL_PREVIEW_MANIFEST,
  VISUAL_PREVIEW_RUNTIME_DIRECTORIES,
  redactVisualPreviewPaths,
} from './visualPreviewPaths.js';

export {
  VISUAL_PREVIEW_DIRECTORY,
  VISUAL_PREVIEW_MANIFEST,
  VISUAL_PREVIEW_RUNTIME_DIRECTORIES,
  VISUAL_PREVIEW_SOURCE_DIRECTORY,
  redactVisualPreviewValue,
  redactVisualPreviewPaths,
} from './visualPreviewPaths.js';
export {
  createPublishedVisualPreviewMetadata,
  trustedGitHubAttachmentUrl,
  VISUAL_PREVIEW_MARKER,
  VISUAL_PREVIEW_SLOT,
} from './visualPreviewRendering.js';
export type {
  CreatePublishedVisualPreviewMetadataOptions,
  PublishedVisualPreviewAssetInput,
  PublishedVisualPreviewMetadata,
  RenderVisualPreviewOptions,
  RenderVisualPreviewUploadFailureOptions,
} from './visualPreviewRendering.js';

import {
  appendVisualPreviewSection as appendRenderedVisualPreviewSection,
  renderVisualPreviewSection as renderPreviewSection,
  renderVisualPreviewUploadFailureSection as renderUploadFailureSection,
  type RenderVisualPreviewOptions,
  type RenderVisualPreviewUploadFailureOptions,
} from './visualPreviewRendering.js';

function publicVisualPreviewEvidence(evidence: VisualPreviewEvidence): VisualPreviewEvidence {
  return {
    ...evidence,
    assets: evidence.assets.map(asset => ({
      ...asset,
      title: redactVisualPreviewPaths(asset.title),
      description: asset.description ? redactVisualPreviewPaths(asset.description) : undefined,
    })),
    toolSuggestions: evidence.toolSuggestions.map(suggestion => ({
      name: redactVisualPreviewPaths(suggestion.name),
      reason: redactVisualPreviewPaths(suggestion.reason),
    })),
  };
}

export function renderVisualPreviewSection(evidence: VisualPreviewEvidence, options: RenderVisualPreviewOptions): string {
  return renderPreviewSection(publicVisualPreviewEvidence(evidence), options);
}

export function renderVisualPreviewUploadFailureSection(
  evidence: VisualPreviewEvidence,
  options: RenderVisualPreviewUploadFailureOptions = {},
): string {
  return renderUploadFailureSection(publicVisualPreviewEvidence(evidence), options);
}

export function appendVisualPreviewSection(body: string, section: string): string {
  return appendRenderedVisualPreviewSection(redactVisualPreviewPaths(body), section);
}

const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_PREVIEW_ASSETS = 8;
const IMAGE_EXTENSIONS = new Set(['.gif', '.jpeg', '.jpg', '.png', '.svg', '.webp']);
const VIDEO_EXTENSIONS = new Set(['.mov', '.mp4', '.webm']);

export interface VisualPreviewAsset {
  /** Snapshot for publisher selection; GitHub publishers revalidate the file before upload. */
  githubInline?: GitHubInlineEligibility;
  /** Snapshot used to revalidate the staged copy against the same MIME-specific authority. */
  originalStaging?: VisualPreviewOriginalAssetCapacity;
  sizeBytes?: number;
  relativePath: string;
  absolutePath: string;
  type: VisualPreviewType;
  title: string;
  description?: string;
}

export interface VisualPreviewToolSuggestion {
  name: string;
  reason: string;
}

export interface VisualPreviewEvidence {
  githubAttachmentCapacity?: GitHubAttachmentCapacity;
  originalCapacity?: VisualPreviewOriginalCapacity;
  /** Populated when evidence is staged for a task; used to authorize managed originals. */
  taskId?: string;
  assets: VisualPreviewAsset[];
  toolSuggestions: VisualPreviewToolSuggestion[];
}

interface VisualPreviewManifestEntry {
  path?: unknown;
  title?: unknown;
  description?: unknown;
}

interface VisualPreviewManifestData {
  previews?: unknown;
  toolSuggestions?: unknown;
}

export interface CollectVisualPreviewEvidenceOptions {
  worktreePath: string;
  changedFiles: readonly string[];
  settings: VisualPreviewSettings;
}

export interface PrepareVisualPreviewEvidenceOptions {
  worktreePath: string;
  settings: VisualPreviewSettings;
  taskId: string;
  changedFiles?: readonly string[];
}

export interface PreparedVisualPreviewEvidence {
  evidence: VisualPreviewEvidence;
  temporaryDirectory?: string;
}

function previewTypeForPath(filePath: string): VisualPreviewType | null {
  const extension = path.posix.extname(filePath).toLowerCase();
  if (IMAGE_EXTENSIONS.has(extension)) return 'image';
  if (VIDEO_EXTENSIONS.has(extension)) return 'video';
  return null;
}

function normalizeRepositoryPath(filePath: string): string | null {
  const normalized = path.posix.normalize(filePath.replaceAll('\\', '/')).replace(/^\.\//, '');
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) {
    return null;
  }
  return normalized;
}

function normalizeManifestPath(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const candidate = value.trim().replaceAll('\\', '/');
  return normalizeRepositoryPath(candidate.startsWith(`${VISUAL_PREVIEW_DIRECTORY}/`)
    ? candidate
    : `${VISUAL_PREVIEW_DIRECTORY}/${candidate}`);
}

function plainText(value: unknown, maximumLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  return normalized ? normalized.slice(0, maximumLength) : undefined;
}

function inferredTitle(filePath: string): string {
  const stem = path.posix.basename(filePath, path.posix.extname(filePath));
  const title = stem.replace(/[-_]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  return title ? title.replace(/^./, character => character.toUpperCase()) : 'Visual preview';
}

async function readManifest(worktreePath: string, changedFiles: Set<string>): Promise<VisualPreviewManifestData | null> {
  if (!changedFiles.has(VISUAL_PREVIEW_MANIFEST)) return null;
  const manifestPath = path.resolve(worktreePath, VISUAL_PREVIEW_MANIFEST);
  try {
    const stats = await lstat(manifestPath);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_MANIFEST_BYTES) return null;
    const [realRoot, realManifest] = await Promise.all([realpath(worktreePath), realpath(manifestPath)]);
    if (realManifest !== realRoot && !realManifest.startsWith(`${realRoot}${path.sep}`)) return null;
    const parsed = JSON.parse(await readFile(manifestPath, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as VisualPreviewManifestData
      : null;
  } catch {
    return null;
  }
}

function manifestEntriesByPath(manifest: VisualPreviewManifestData | null): Map<string, VisualPreviewManifestEntry> {
  const entries = new Map<string, VisualPreviewManifestEntry>();
  if (!Array.isArray(manifest?.previews)) return entries;
  for (const value of manifest.previews) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const entry = value as VisualPreviewManifestEntry;
    const normalizedPath = normalizeManifestPath(entry.path);
    if (normalizedPath) entries.set(normalizedPath, entry);
  }
  return entries;
}

function manifestToolSuggestions(manifest: VisualPreviewManifestData | null): VisualPreviewToolSuggestion[] {
  if (!Array.isArray(manifest?.toolSuggestions)) return [];
  return manifest.toolSuggestions.flatMap(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    const candidate = value as { name?: unknown; reason?: unknown };
    const name = plainText(candidate.name, 80);
    const reason = plainText(candidate.reason, 300);
    return name && reason ? [{ name, reason }] : [];
  }).slice(0, 5);
}

async function collectAsset({
  worktreePath, relativePath, type, manifestEntry, capacity, originalStaging,
}: {
  worktreePath: string;
  relativePath: string;
  type: VisualPreviewType;
  manifestEntry: VisualPreviewManifestEntry | undefined;
  capacity: GitHubAttachmentCapacity;
  originalStaging: VisualPreviewOriginalAssetCapacity;
}): Promise<{ asset?: VisualPreviewAsset; oversizedSource?: VisualPreviewOriginalAssetCapacity['source'] }> {
  const absolutePath = path.resolve(worktreePath, relativePath);
  const root = path.resolve(worktreePath);
  if (absolutePath !== root && !absolutePath.startsWith(`${root}${path.sep}`)) return {};

  let sizeBytes: number;
  try {
    const stats = await lstat(absolutePath);
    if (!stats.isFile() || stats.isSymbolicLink()) return {};
    const [realRoot, realAsset] = await Promise.all([realpath(root), realpath(absolutePath)]);
    if (realAsset !== realRoot && !realAsset.startsWith(`${realRoot}${path.sep}`)) return {};
    if (stats.size === 0) return {};
    if (stats.size > originalStaging.limitBytes) return { oversizedSource: originalStaging.source };
    sizeBytes = stats.size;
  } catch {
    return {};
  }

  return {
    asset: {
      sizeBytes,
      originalStaging,
      githubInline: githubInlineEligibility(VISUAL_PREVIEW_CONTENT_TYPES[path.extname(relativePath).toLowerCase()], sizeBytes, capacity),
      relativePath,
      absolutePath,
      type,
      title: plainText(manifestEntry?.title, 120) || inferredTitle(relativePath),
      ...(plainText(manifestEntry?.description, 300)
        ? { description: plainText(manifestEntry?.description, 300) }
        : {})
    }
  };
}

export async function collectVisualPreviewEvidence({
  worktreePath,
  changedFiles,
  settings
}: CollectVisualPreviewEvidenceOptions): Promise<VisualPreviewEvidence> {
  if (!settings.enabled) return { assets: [], toolSuggestions: [] };

  const normalizedChangedFiles = new Set(changedFiles
    .map(normalizeRepositoryPath)
    .filter((filePath): filePath is string => Boolean(filePath)));
  const manifest = await readManifest(worktreePath, normalizedChangedFiles);
  const manifestEntries = manifestEntriesByPath(manifest);
  const toolSuggestions = manifestToolSuggestions(manifest);
  const candidates = [...normalizedChangedFiles]
    .filter(filePath => filePath.startsWith(`${VISUAL_PREVIEW_DIRECTORY}/`))
    .map(filePath => ({ filePath, type: previewTypeForPath(filePath) }))
    .filter((candidate): candidate is { filePath: string; type: VisualPreviewType } => candidate.type !== null)
    .filter(candidate => settings.types.includes(candidate.type))
    .sort((left, right) => left.filePath.localeCompare(right.filePath))
    .slice(0, MAX_PREVIEW_ASSETS);

  const capacity = resolveGitHubAttachmentCapacity(settings.githubAttachmentPlan, settings.githubAttachmentCapacity?.detectedPlan);
  const originalCapacity = resolveVisualPreviewOriginalCapacity(settings.originalEvidenceCapability, capacity);
  const assets: VisualPreviewAsset[] = [];
  const oversizedSources = new Set<VisualPreviewOriginalAssetCapacity['source']>();
  for (const candidate of candidates) {
    const originalStaging = resolveVisualPreviewOriginalAssetCapacity(VISUAL_PREVIEW_CONTENT_TYPES[path.extname(candidate.filePath).toLowerCase()], settings.originalEvidenceCapability, capacity)!;
    const collected = await collectAsset({
      worktreePath, relativePath: candidate.filePath, type: candidate.type,
      manifestEntry: manifestEntries.get(candidate.filePath), capacity, originalStaging,
    });
    if (collected.asset) assets.push(collected.asset);
    if (collected.oversizedSource) oversizedSources.add(collected.oversizedSource);
  }

  if (oversizedSources.size > 0) {
    toolSuggestions.push({
      name: 'Media compression tooling',
      reason: oversizedSources.has('legacy') ? 'At least one generated preview whose content type is not accepted by managed storage exceeded its legacy original-evidence staging safety limit; install or use an image optimizer or ffmpeg to fit that limit.' : 'At least one generated preview exceeded the managed original-evidence staging safety limit; install or use an image optimizer or ffmpeg to fit that limit.'
    });
  }

  return { assets, toolSuggestions: toolSuggestions.slice(0, 5), githubAttachmentCapacity: capacity, originalCapacity };
}

function safeTemporaryName(taskId: string): string {
  const sanitized = taskId.replace(/[^a-zA-Z0-9_-]+/g, '-');
  let start = 0;
  let end = sanitized.length;
  while (sanitized[start] === '-') start += 1;
  while (end > start && sanitized[end - 1] === '-') end -= 1;
  const normalized = sanitized.slice(start, Math.min(end, start + 80));
  return normalized || 'task';
}

async function copyEvidenceToTemporaryDirectory(
  evidence: VisualPreviewEvidence,
  taskId: string
): Promise<PreparedVisualPreviewEvidence> {
  if (evidence.assets.length === 0) return { evidence };

  const temporaryRoot = path.join(tmpdir(), 'propr-previews');
  await mkdir(temporaryRoot, { recursive: true });
  const temporaryDirectory = await mkdtemp(path.join(temporaryRoot, `${safeTemporaryName(taskId)}-`));

  try {
    const assets: VisualPreviewAsset[] = [];
    for (const asset of evidence.assets) {
      const previewRelativePath = asset.relativePath.slice(`${VISUAL_PREVIEW_DIRECTORY}/`.length);
      const destination = path.resolve(temporaryDirectory, previewRelativePath);
      if (!destination.startsWith(`${temporaryDirectory}${path.sep}`)) {
        throw new Error(`Invalid visual preview path: ${asset.relativePath}`);
      }
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(asset.absolutePath, destination);
      const { size: sizeBytes } = await lstat(destination);
      const fallbackLimit = asset.type === 'image' ? evidence.originalCapacity!.imageLimitBytes : evidence.originalCapacity!.videoLimitBytes;
      if (sizeBytes > (asset.originalStaging?.limitBytes ?? fallbackLimit)) {
        throw new Error('Visual preview grew beyond the original-evidence staging safety limit');
      }
      assets.push({
        ...asset,
        absolutePath: destination,
        sizeBytes,
        githubInline: githubInlineEligibility(VISUAL_PREVIEW_CONTENT_TYPES[path.extname(destination).toLowerCase()], sizeBytes, evidence.githubAttachmentCapacity),
      });
    }
    return { evidence: { ...evidence, taskId, assets }, temporaryDirectory };
  } catch (error) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    throw error;
  }
}

async function scrubVisualPreviewDirectories(worktreePath: string): Promise<void> {
  const git = createHooklessGit(worktreePath);
  const indexedPreviewPaths = (await git.raw([
    'ls-files', '-z', '--', ...VISUAL_PREVIEW_RUNTIME_DIRECTORIES
  ])).split('\0').filter(Boolean);

  for (const runtimeDirectory of VISUAL_PREVIEW_RUNTIME_DIRECTORIES) {
    await rm(path.resolve(worktreePath, runtimeDirectory), { recursive: true, force: true });
    if (indexedPreviewPaths.some(filePath =>
      filePath === runtimeDirectory || filePath.startsWith(`${runtimeDirectory}/`)
    )) {
      await git.raw(['restore', '--source=HEAD', '--staged', '--worktree', '--', runtimeDirectory]);
    }
  }
}

async function currentPreviewChangePaths(worktreePath: string): Promise<string[]> {
  const git = createHooklessGit(worktreePath);
  const statusPaths = (await git.status()).files.map(file => file.path);
  const ignoredPreviewPaths = (await git.raw([
    'ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--', VISUAL_PREVIEW_DIRECTORY
  ])).split('\0').filter(Boolean);
  return [...new Set([...statusPaths, ...ignoredPreviewPaths])];
}

/**
 * Captures current preview evidence outside the repository, then restores the
 * preview runtime directories to HEAD so a later `git add .` cannot commit
 * media or preview-only source files.
 */
export async function prepareVisualPreviewEvidence({
  worktreePath,
  settings,
  taskId,
  changedFiles
}: PrepareVisualPreviewEvidenceOptions): Promise<PreparedVisualPreviewEvidence> {
  let prepared: PreparedVisualPreviewEvidence | undefined;
  let preparationFailed = false;
  let preparationError: unknown;
  try {
    const files = changedFiles ?? await currentPreviewChangePaths(worktreePath);
    const evidence = await collectVisualPreviewEvidence({ worktreePath, changedFiles: files, settings });
    prepared = await copyEvidenceToTemporaryDirectory(evidence, taskId);
  } catch (error) {
    preparationFailed = true;
    preparationError = error;
  }

  try {
    await scrubVisualPreviewDirectories(worktreePath);
  } catch (error) {
    await cleanupPreparedVisualPreviewEvidence(prepared);
    throw error;
  }

  if (preparationFailed) throw preparationError;
  return prepared!;
}

export async function cleanupPreparedVisualPreviewEvidence(
  prepared: PreparedVisualPreviewEvidence | undefined
): Promise<void> {
  if (!prepared?.temporaryDirectory) return;
  await rm(prepared.temporaryDirectory, { recursive: true, force: true });
}

export function buildVisualPreviewPrompt(settings: VisualPreviewSettings): string {
  if (!settings.enabled) return '';
  const githubCapacity = resolveGitHubAttachmentCapacity(settings.githubAttachmentPlan, settings.githubAttachmentCapacity?.detectedPlan);
  const capacityInstructions = describeVisualPreviewOriginalCapacity(
    settings.originalEvidenceCapability, githubCapacity, settings.types);
  const additionalInstructions = settings.instructions
    ? `\nRepository-specific capture instructions (apply only to preview generation):\n${settings.instructions}\n`
    : '';

  return `
**VISUAL PREVIEW REQUIREMENT:**
Visual previews are enabled for this repository. After implementing and testing, decide whether the result is perceptible visually to a user. If it is not visually perceptible, do not create preview files. If it is visually perceptible:
- Treat previews as evidence only: never expand the implementation scope. Do not create or update preview files when the current request produces no implementation changes, unless the user explicitly asks to generate or refresh previews for changes already present on the branch.
- Generate focused ${settings.types.join(' and ')} preview evidence of the current change using the project’s existing, relevant tooling (for example a headless browser, Storybook, an Android/iOS emulator, or a project-native renderer).
- Capture the changed state itself, not generic application screens. Use realistic viewport/device states and follow the repository-specific instructions below when present.
- Store each preview under the transient runtime directory \`${VISUAL_PREVIEW_DIRECTORY}/\`; never commit that directory yourself. Use portable filenames and only these formats: PNG/JPEG/GIF/SVG/WebP for images; MP4/MOV/WebM for videos. For video, prefer H.264 in MP4 for browser compatibility.
- GitHub inline publication limits: images at or below 10 MiB; videos at or below ${githubCapacity.videoLimitBytes / MIB} MiB. These are publication limits, separate from original-evidence staging eligibility.
- ${capacityInstructions}
- Write \`${VISUAL_PREVIEW_MANIFEST}\` with this shape: \`{"previews":[{"path":".propr/previews/desktop.png","title":"Desktop dialog","description":"The changed dialog at desktop width"}],"toolSuggestions":[{"name":"Playwright Chromium","reason":"Needed to capture the running web UI"}]}\`. The manifest may contain an empty previews array when capture is blocked.
- Do not link to local preview or manifest paths in your final response. ProPR reads the manifest and publishes the preview attachments separately.
- Do not fabricate a preview or hand-draw a substitute. If the project cannot be run or the needed capture tool is unavailable, record concise, actionable \`toolSuggestions\` in the manifest describing what should be installed in the agent image and why.
- Never include credentials, tokens, personal data, or unrelated screens in preview media.
${additionalInstructions}`;
}
