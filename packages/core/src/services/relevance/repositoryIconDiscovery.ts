import type { Logger } from 'pino';

const SUPPORTED_EXTENSIONS = ['png', 'svg', 'ico', 'webp', 'jpg', 'jpeg', 'avif'] as const;

// These paths retain the priority used by the original implementation. They
// are checked against the tracked-file list, so an ignored or untracked asset
// can no longer become repository metadata accidentally.
const EXPLICIT_PATHS = [
  'public/apple-touch-icon.png',
  'apple-touch-icon.png',
  'public/favicon.svg',
  'favicon.svg',
  'public/favicon.png',
  'public/icon.png',
  'public/logo.png',
  'favicon.png',
  'app/icon.png',
  'src/app/icon.png',
  'public/favicon.ico',
  'favicon.ico',
  'app/favicon.ico',
  'static/favicon.ico',
  'src-tauri/icons/icon.png',
  'build/icon.png',
  'assets/icon.png',
  'src/assets/icon.png',
  'logo.png',
  'logo.svg',
  'icon.png',
  'icon.svg',
  'logo.jpg',
  'logo.jpeg',
  'icon.jpg',
  'icon.jpeg',
  'app-icon.png',
  'app-icon.svg',
  'brand.png',
  'brand.svg',
] as const;

const EXPLICIT_PRIORITY = new Map<string, number>(
  EXPLICIT_PATHS.map((filePath, index) => [filePath, index]),
);

const EXCLUDED_FALLBACK_DIRECTORIES = new Set([
  'test', 'tests', 'testing', '__tests__',
  'fixture', 'fixtures', '__fixtures__', 'testdata',
  'example', 'examples', 'demo', 'demos', 'sample', 'samples',
  'storybook', 'stories', '__snapshots__',
  'node_modules', 'vendor', 'vendors', 'third_party', 'third-party', 'external', 'pods',
  'bower_components', 'jspm_packages', '.yarn', '.pnpm', 'deps', 'dependencies',
  'dist', 'build', 'out', 'output', '.output', 'generated', 'coverage',
  '.next', '.nuxt', '.cache', 'target', 'bin', 'obj',
]);

const FORMAT_PRIORITY = new Map<string, number>(
  SUPPORTED_EXTENSIONS.map((extension, index) => [extension, index]),
);

interface RankedCandidate {
  path: string;
  explicitRank: number;
  familyRank: number;
  directoryRank: number;
  formatRank: number;
}

function getFilenameFamilyRank(stem: string): number | null {
  if (/^apple[-_]?touch[-_]?icon(?:[-_].+)?$/.test(stem)) return 0;
  if (/^favicon(?:[-_].+)?$/.test(stem)) return 1;
  if (/^(?:touch[-_]?icon|mstile|android[-_]?chrome|mask[-_]?icon|safari[-_]?pinned[-_]?tab)(?:[-_].+)?$/.test(stem)) return 2;
  if (/^(?:ic[-_]?launcher|launcher[-_]?icon)(?:[-_].+)?$/.test(stem)) return 3;
  if (/^(?:(?:app|application|adaptive)[-_]?icon|pwa|web[-_]?app[-_]?manifest)(?:[-_].+)?$/.test(stem)) return 4;
  if (/^icon(?:[-_].+)?$/.test(stem)) return 5;
  if (/^(?:logo(?:[-_]?\d+|[-_].+)?|.+[-_]logo)$/.test(stem)) return 6;
  if (/^(?:brand[-_]?mark|brandmark|wordmark)(?:[-_].+)?$/.test(stem)) return 7;
  if (/^brand(?:[-_].+)?$/.test(stem)) return 8;
  return null;
}

function isAndroidLauncherDirectory(segments: string[]): boolean {
  return segments.some((segment, index) =>
    segment === 'res' && segments[index + 1]?.startsWith('mipmap'),
  );
}

function getDirectoryRank(directorySegments: string[]): number {
  if (directorySegments.length === 0) return 0;
  if (directorySegments.includes('public') || isAndroidLauncherDirectory(directorySegments)) return 0;
  if (directorySegments.includes('static') || directorySegments.includes('resources')) return 1;
  if (directorySegments.includes('icons') || directorySegments.includes('assets')) return 2;
  if (directorySegments.includes('images') || directorySegments.includes('img')) return 3;
  if (directorySegments.includes('app')) return 4;
  return 5;
}

function rankCandidate(filePath: string): RankedCandidate | null {
  if (filePath.includes('\\')) return null;
  const normalizedPath = filePath.replace(/^\.\//, '');
  const lowerPath = normalizedPath.toLowerCase();
  const explicitRank = EXPLICIT_PRIORITY.get(lowerPath);
  const segments = lowerPath.split('/');
  const filename = segments.at(-1) || '';
  const extensionSeparator = filename.lastIndexOf('.');
  if (extensionSeparator <= 0) return null;

  const extension = filename.slice(extensionSeparator + 1);
  const formatRank = FORMAT_PRIORITY.get(extension);
  if (formatRank === undefined) return null;

  if (explicitRank !== undefined) {
    return { path: normalizedPath, explicitRank, familyRank: 0, directoryRank: 0, formatRank };
  }

  const directorySegments = segments.slice(0, -1);
  if (directorySegments.some(segment => EXCLUDED_FALLBACK_DIRECTORIES.has(segment))) return null;

  const familyRank = getFilenameFamilyRank(filename.slice(0, extensionSeparator));
  if (familyRank === null) return null;

  return {
    path: normalizedPath,
    explicitRank: EXPLICIT_PATHS.length,
    familyRank,
    directoryRank: getDirectoryRank(directorySegments),
    formatRank,
  };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareCandidates(left: RankedCandidate, right: RankedCandidate): number {
  return left.explicitRank - right.explicitRank
    || left.familyRank - right.familyRank
    || left.directoryRank - right.directoryRank
    || left.formatRank - right.formatRank
    || compareText(left.path.toLowerCase(), right.path.toLowerCase())
    || compareText(left.path, right.path);
}

/** Selects the highest-priority icon from an already-fetched Git tracked-file list. */
export function selectRepositoryIcon(files: ReadonlyArray<{ path: string }>): string | null {
  const candidates = files
    .map(file => rankCandidate(file.path))
    .filter((candidate): candidate is RankedCandidate => candidate !== null)
    .sort(compareCandidates);
  return candidates[0]?.path ?? null;
}

export function discoverRepositoryIcon(
  files: ReadonlyArray<{ path: string }>,
  log: Logger,
): string | null {
  const iconPath = selectRepositoryIcon(files);
  if (iconPath) log.info({ iconPath }, 'Discovered repository icon');
  else log.debug('No repository icon found in tracked files');
  return iconPath;
}
