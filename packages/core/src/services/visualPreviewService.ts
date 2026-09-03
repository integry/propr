import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { VisualPreviewSettings, VisualPreviewType } from '../config/configManager.js';
import { createHooklessGit } from '../git/hooklessGit.js';

export const VISUAL_PREVIEW_DIRECTORY = '.propr/previews';
export const VISUAL_PREVIEW_MANIFEST = `${VISUAL_PREVIEW_DIRECTORY}/manifest.json`;
export const VISUAL_PREVIEW_MARKER = '<!-- propr-visual-preview -->';
export const VISUAL_PREVIEW_SLOT = '<!-- propr-visual-preview-slot -->';

const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_GITHUB_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_PREVIEW_ASSETS = 8;
const IMAGE_EXTENSIONS = new Set(['.gif', '.jpeg', '.jpg', '.png', '.svg', '.webp']);
const VIDEO_EXTENSIONS = new Set(['.mov', '.mp4', '.webm']);

export interface VisualPreviewAsset {
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

export interface RenderVisualPreviewOptions {
  useLocalPaths?: boolean;
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

async function collectAsset(
  worktreePath: string,
  relativePath: string,
  type: VisualPreviewType,
  manifestEntry: VisualPreviewManifestEntry | undefined
): Promise<{ asset?: VisualPreviewAsset; oversized?: boolean }> {
  const absolutePath = path.resolve(worktreePath, relativePath);
  const root = path.resolve(worktreePath);
  if (absolutePath !== root && !absolutePath.startsWith(`${root}${path.sep}`)) return {};

  try {
    const stats = await lstat(absolutePath);
    if (!stats.isFile() || stats.isSymbolicLink()) return {};
    const [realRoot, realAsset] = await Promise.all([realpath(root), realpath(absolutePath)]);
    if (realAsset !== realRoot && !realAsset.startsWith(`${realRoot}${path.sep}`)) return {};
    if (stats.size === 0) return {};
    if (stats.size > MAX_GITHUB_ATTACHMENT_BYTES) return { oversized: true };
  } catch {
    return {};
  }

  return {
    asset: {
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

  const assets: VisualPreviewAsset[] = [];
  let oversized = false;
  for (const candidate of candidates) {
    const collected = await collectAsset(worktreePath, candidate.filePath, candidate.type, manifestEntries.get(candidate.filePath));
    if (collected.asset) assets.push(collected.asset);
    oversized ||= collected.oversized === true;
  }

  if (oversized) {
    toolSuggestions.push({
      name: 'Media compression tooling',
      reason: 'At least one generated preview exceeded GitHub’s universal 10 MB attachment limit; install or use an image optimizer or ffmpeg to shrink it.'
    });
  }

  return { assets, toolSuggestions: toolSuggestions.slice(0, 5) };
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
      assets.push({ ...asset, absolutePath: destination });
    }
    return { evidence: { ...evidence, assets }, temporaryDirectory };
  } catch (error) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    throw error;
  }
}

async function scrubVisualPreviewDirectory(worktreePath: string): Promise<void> {
  const previewDirectory = path.resolve(worktreePath, VISUAL_PREVIEW_DIRECTORY);
  await rm(previewDirectory, { recursive: true, force: true });

  const git = createHooklessGit(worktreePath);
  const indexedPreviews = (await git.raw(['ls-files', '--', VISUAL_PREVIEW_DIRECTORY])).trim();
  if (indexedPreviews) {
    await git.raw(['restore', '--source=HEAD', '--staged', '--worktree', '--', VISUAL_PREVIEW_DIRECTORY]);
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
 * preview directory to HEAD so a later `git add .` cannot commit runtime media.
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
    await scrubVisualPreviewDirectory(worktreePath);
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

function markdownText(value: string): string {
  return value.replace(/([\\`*_[\]{}()<>#+.!|])/g, '\\$1');
}

function markdownTarget(target: string): string {
  return /[\s()]/.test(target) ? `<${target.replaceAll('>', '%3E')}>` : target;
}

export function renderVisualPreviewSection(
  evidence: VisualPreviewEvidence,
  options: RenderVisualPreviewOptions
): string {
  const assets = options.useLocalPaths ? evidence.assets : [];
  if (assets.length === 0 && evidence.toolSuggestions.length === 0) return '';
  const parts = [VISUAL_PREVIEW_MARKER, '## Visual preview'];

  for (const asset of assets) {
    const target = asset.absolutePath;
    parts.push(`### ${markdownText(asset.title)}`);
    parts.push(`![${asset.type === 'image' ? markdownText(asset.title) : ''}](${markdownTarget(target)})`);
    if (asset.description) parts.push(markdownText(asset.description));
  }

  if (evidence.toolSuggestions.length > 0) {
    parts.push('### Suggested agent tools');
    parts.push(evidence.toolSuggestions
      .map(suggestion => `- **${markdownText(suggestion.name)}:** ${markdownText(suggestion.reason)}`)
      .join('\n'));
  }

  return parts.join('\n\n');
}

export function renderVisualPreviewUploadFailureSection(evidence: VisualPreviewEvidence): string {
  const parts = [
    VISUAL_PREVIEW_MARKER,
    '## Visual preview',
    'Preview media was generated but could not be uploaded to GitHub. No preview files were committed.'
  ];
  if (evidence.toolSuggestions.length > 0) {
    parts.push('### Suggested agent tools');
    parts.push(evidence.toolSuggestions
      .map(suggestion => `- **${markdownText(suggestion.name)}:** ${markdownText(suggestion.reason)}`)
      .join('\n'));
  }
  return parts.join('\n\n');
}

export function appendVisualPreviewSection(body: string, section: string): string {
  if (!section) return body.replace(VISUAL_PREVIEW_SLOT, '');
  if (body.includes(VISUAL_PREVIEW_SLOT)) return body.replace(VISUAL_PREVIEW_SLOT, section);
  return `${body.trim()}\n\n---\n\n${section}`;
}

export function buildVisualPreviewPrompt(settings: VisualPreviewSettings): string {
  if (!settings.enabled) return '';
  const requestedTypes = settings.types.join(' and ');
  const additionalInstructions = settings.instructions
    ? `\nRepository-specific capture instructions (apply only to preview generation):\n${settings.instructions}\n`
    : '';

  return `
**VISUAL PREVIEW REQUIREMENT:**
Visual previews are enabled for this repository. After implementing and testing, decide whether the result is perceptible visually to a user. If it is not visually perceptible, do not create preview files. If it is visually perceptible:
- Treat previews as evidence only: never expand the implementation scope. Do not create or update preview files when the current request produces no implementation changes, unless the user explicitly asks to generate or refresh previews for changes already present on the branch.
- Generate focused ${requestedTypes} preview evidence of the current change using the project’s existing, relevant tooling (for example a headless browser, Storybook, an Android/iOS emulator, or a project-native renderer).
- Capture the changed state itself, not generic application screens. Use realistic viewport/device states and follow the repository-specific instructions below when present.
- Store each preview under the transient runtime directory \`${VISUAL_PREVIEW_DIRECTORY}/\`; never commit that directory yourself. Use portable filenames and only these formats: PNG/JPEG/GIF/SVG/WebP for images; MP4/MOV/WebM for videos. Keep every file below 10 MB. For video, prefer H.264 in MP4 for browser compatibility.
- Write \`${VISUAL_PREVIEW_MANIFEST}\` with this shape: \`{"previews":[{"path":".propr/previews/desktop.png","title":"Desktop dialog","description":"The changed dialog at desktop width"}],"toolSuggestions":[{"name":"Playwright Chromium","reason":"Needed to capture the running web UI"}]}\`. The manifest may contain an empty previews array when capture is blocked.
- Do not link to local preview or manifest paths in your final response. ProPR reads the manifest and publishes the preview attachments separately.
- Do not fabricate a preview or hand-draw a substitute. If the project cannot be run or the needed capture tool is unavailable, record concise, actionable \`toolSuggestions\` in the manifest describing what should be installed in the agent image and why.
- Never include credentials, tokens, personal data, or unrelated screens in preview media.
${additionalInstructions}`;
}
