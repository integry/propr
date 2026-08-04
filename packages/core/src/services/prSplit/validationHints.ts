import { posix } from 'node:path';
import type {
  PrSnapshot,
  PrSnapshotFile,
  PrSnapshotRepositoryFile,
  ValidationHint,
  ValidationHintSource,
  ValidationPlan,
} from './types.js';

const VALIDATION_WORDS = /\b(test|lint|build|check|typecheck|verify|pytest|rspec)\b/i;
const TEST_PATH = /(^|\/)(tests?|spec|__tests__)(\/|$)|\.(test|spec)\.[^.]+$|_test\.[^.]+$/i;
const SUPPORTED_PACKAGE_SCRIPTS = ['test', 'lint', 'build', 'check', 'typecheck', 'verify'] as const;

type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

interface HintDetails {
  reason: string;
  source: ValidationHintSource;
  relatedFiles: string[];
  workingDirectory?: string;
  confidence: ValidationHint['confidence'];
  executable: boolean;
}

interface ConventionDetails {
  extension: RegExp;
  configName: RegExp;
  command: string;
  reason: string;
}

function selectedSnapshotFiles(snapshot: PrSnapshot, includedFiles?: readonly string[]): PrSnapshotFile[] {
  if (!includedFiles) return snapshot.changedFiles;
  const selected = new Set(includedFiles);
  return snapshot.changedFiles.filter(file => selected.has(file.filename));
}

function repositoryFiles(snapshot: PrSnapshot): PrSnapshotRepositoryFile[] {
  const files = new Map(snapshot.repositoryFiles.map(file => [file.path, file]));
  for (const changed of snapshot.changedFiles) {
    if (changed.headContent === null || files.has(changed.filename)) continue;
    files.set(changed.filename, {
      path: changed.filename,
      content: changed.headContent,
      contentComplete: changed.contentComplete,
    });
  }
  return [...files.values()];
}

function isWithinDirectory(path: string, directory: string): boolean {
  return directory === '.' || path === directory || path.startsWith(`${directory}/`);
}

function nearestFile(
  path: string,
  files: readonly PrSnapshotRepositoryFile[],
  predicate: (file: PrSnapshotRepositoryFile) => boolean,
): PrSnapshotRepositoryFile | null {
  return files
    .filter(file => predicate(file) && isWithinDirectory(path, posix.dirname(file.path)))
    .sort((left, right) => posix.dirname(right.path).length - posix.dirname(left.path).length)[0]
    ?? null;
}

function packageManager(
  manifest: PrSnapshotRepositoryFile,
  files: readonly PrSnapshotRepositoryFile[],
): PackageManager {
  const path = manifest.path;
  const directories: string[] = [];
  let directory = posix.dirname(path);
  while (true) {
    directories.push(directory);
    if (directory === '.') break;
    directory = posix.dirname(directory);
  }
  const has = (name: RegExp): boolean => directories.some(candidate => files.some(file =>
    posix.dirname(file.path) === candidate && name.test(posix.basename(file.path))));
  if (has(/^pnpm-lock\.yaml$/i)) return 'pnpm';
  if (has(/^yarn\.lock$/i)) return 'yarn';
  if (has(/^bun\.lockb?$/i)) return 'bun';
  return 'npm';
}

function packageScriptCommand(manager: PackageManager, script: string): string {
  if (manager === 'yarn') return `yarn ${script}`;
  if (manager === 'bun') return `bun run ${script}`;
  if (manager === 'npm' && script === 'test') return 'npm test';
  return `${manager} run ${script}`;
}

function addHint(hints: ValidationHint[], command: string, details: HintDetails): void {
  const normalized = command
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
  const workingDirectory = details.workingDirectory || '.';
  if (
    !normalized
    || hints.some(hint => hint.command === normalized
      && hint.workingDirectory === workingDirectory
      && hint.executable === details.executable)
  ) return;
  hints.push({
    command: normalized,
    reason: details.reason,
    source: details.source,
    relatedFiles: [...new Set(details.relatedFiles)].sort(),
    workingDirectory,
    confidence: details.confidence,
    executable: details.executable,
  });
}

/** Workflow shell text is untrusted and is retained only as a display-only observation. */
function workflowObservations(files: PrSnapshotFile[], hints: ValidationHint[]): void {
  for (const file of files) {
    if (!/(^|\/)\.github\/workflows\/.*\.ya?ml$/i.test(file.filename)) continue;
    const content = file.headContent ?? file.patch;
    if (!content) continue;
    for (const line of content.split(/\r?\n/)) {
      const match = line.match(/^\s*[+ ]?\s*(?:-\s*)?run:\s*(.+?)\s*$/i);
      if (!match || !VALIDATION_WORDS.test(match[1])) continue;
      addHint(hints, match[1].replace(/^['"]|['"]$/g, ''), {
        reason: `Display-only workflow validation step from ${file.filename}; never execute this discovered shell text directly`,
        source: 'workflow',
        relatedFiles: [file.filename],
        confidence: 'low',
        executable: false,
      });
    }
  }
}

function parsedPackageScripts(file: PrSnapshotRepositoryFile): Set<string> {
  if (!file.contentComplete || file.content === null) return new Set();
  try {
    const parsed: unknown = JSON.parse(file.content);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return new Set();
    const scripts = (parsed as Record<string, unknown>).scripts;
    if (typeof scripts !== 'object' || scripts === null || Array.isArray(scripts)) return new Set();
    return new Set(Object.entries(scripts)
      .filter(([, value]) => typeof value === 'string')
      .map(([name]) => name.toLowerCase()));
  } catch {
    return new Set();
  }
}

function javascriptHints(
  selectedFiles: PrSnapshotFile[],
  configs: readonly PrSnapshotRepositoryFile[],
  hints: ValidationHint[],
): void {
  const javascriptFiles = selectedFiles.filter(file => /\.[cm]?[jt]sx?$/i.test(file.filename));
  const byManifest = new Map<string, PrSnapshotFile[]>();
  for (const file of javascriptFiles) {
    const manifest = nearestFile(file.filename, configs, candidate => /(^|\/)package\.json$/i.test(candidate.path));
    if (!manifest) continue;
    byManifest.set(manifest.path, [...(byManifest.get(manifest.path) ?? []), file]);
  }
  for (const [manifestPath, related] of byManifest) {
    const manifest = configs.find(file => file.path === manifestPath);
    if (!manifest) continue;
    const scripts = parsedPackageScripts(manifest);
    const manager = packageManager(manifest, configs);
    const directory = posix.dirname(manifest.path);
    const desired = new Set<string>();
    if (related.some(file => TEST_PATH.test(file.filename))) desired.add('test');
    if (related.some(file => /\.[cm]?tsx?$/i.test(file.filename))) desired.add('typecheck');
    for (const script of SUPPORTED_PACKAGE_SCRIPTS) {
      if (scripts.has(script) && (desired.has(script) || script === 'test' || script === 'lint')) {
        addHint(hints, packageScriptCommand(manager, script), {
          reason: `Allowlisted script declared in the scripts object of ${manifest.path}`,
          source: 'package-script',
          relatedFiles: related.map(file => file.filename),
          workingDirectory: directory,
          confidence: 'high',
          executable: true,
        });
      }
    }
  }
}

function addConvention(
  selectedFiles: PrSnapshotFile[],
  configs: readonly PrSnapshotRepositoryFile[],
  hints: ValidationHint[],
  details: ConventionDetails,
): void {
  const related = selectedFiles.filter(file => details.extension.test(file.filename));
  const groups = new Map<string, string[]>();
  for (const file of related) {
    const config = nearestFile(
      file.filename,
      configs,
      candidate => details.configName.test(posix.basename(candidate.path)),
    );
    if (!config) continue;
    groups.set(config.path, [...(groups.get(config.path) ?? []), file.filename]);
  }
  for (const [configPath, paths] of groups) {
    addHint(hints, details.command, {
      reason: `${details.reason}; repository marker ${configPath} exists at the PR head`,
      source: 'repository-convention',
      relatedFiles: paths,
      workingDirectory: posix.dirname(configPath),
      confidence: 'medium',
      executable: true,
    });
  }
}

function languageHints(
  selectedFiles: PrSnapshotFile[],
  configs: readonly PrSnapshotRepositoryFile[],
  hints: ValidationHint[],
): void {
  addConvention(selectedFiles, configs, hints, {
    extension: /\.go$/i, configName: /^go\.mod$/i, command: 'go test ./...', reason: 'Go source is selected',
  });
  addConvention(selectedFiles, configs, hints, {
    extension: /\.rs$/i, configName: /^Cargo\.toml$/i, command: 'cargo test', reason: 'Rust source is selected',
  });
  addConvention(selectedFiles, configs, hints, {
    extension: /\.py$/i,
    configName: /^(?:pyproject\.toml|requirements[^/]*\.txt)$/i,
    command: 'python -m compileall .',
    reason: 'Python source is selected',
  });
  addConvention(selectedFiles, configs, hints, {
    extension: /\.rb$/i, configName: /^Gemfile$/i, command: 'bundle exec rspec', reason: 'Ruby source is selected',
  });
  addConvention(selectedFiles, configs, hints, {
    extension: /\.php$/i, configName: /^composer\.json$/i, command: 'composer test', reason: 'PHP source is selected',
  });
  addConvention(selectedFiles, configs, hints, {
    extension: /\.java$/i, configName: /^pom\.xml$/i, command: 'mvn test', reason: 'Java source is selected',
  });
  addConvention(selectedFiles, configs, hints, {
    extension: /\.(?:java|kt|kts)$/i,
    configName: /^(?:gradlew|build\.gradle(?:\.kts)?)$/i,
    command: './gradlew test',
    reason: 'Gradle source is selected',
  });

  for (const makefile of configs.filter(file => posix.basename(file.path) === 'Makefile')) {
    if (!makefile.contentComplete || !/^test\s*:/m.test(makefile.content ?? '')) continue;
    const related = selectedFiles.filter(file => isWithinDirectory(file.filename, posix.dirname(makefile.path)));
    if (related.length === 0) continue;
    addHint(hints, 'make test', {
      reason: `A test target is declared in ${makefile.path}`,
      source: 'repository-convention',
      relatedFiles: related.map(file => file.filename),
      workingDirectory: posix.dirname(makefile.path),
      confidence: 'high',
      executable: true,
    });
  }
}

/** Infer structured validation hints without executing untrusted repository code. */
export function inferValidationHints(
  snapshot: PrSnapshot,
  includedFiles?: readonly string[],
): ValidationPlan {
  const selectedFiles = selectedSnapshotFiles(snapshot, includedFiles);
  const configs = repositoryFiles(snapshot);
  const hints: ValidationHint[] = [];
  workflowObservations(selectedFiles, hints);
  javascriptHints(selectedFiles, configs, hints);
  languageHints(selectedFiles, configs, hints);
  const commands = hints.filter(hint => hint.executable).map(hint => hint.command);

  if (commands.length === 0) {
    const repositoryNote = snapshot.repositoryTreeComplete
      ? ''
      : ' Repository configuration discovery was incomplete.';
    return {
      commands: [],
      hints,
      inferred: false,
      explanation: `No trusted executable validation command could be inferred; manual validation is required.${repositoryNote}`,
    };
  }
  return {
    commands,
    hints,
    inferred: true,
    explanation: `${commands.length} trusted validation command${commands.length === 1 ? '' : 's'} inferred with repository-aware working directories.`,
  };
}

export const detectValidationHints = inferValidationHints;
