/* eslint-disable max-lines -- Language-specific safe-command inference shares one confidence boundary. */
import { posix } from 'node:path';
import type {
  PrSnapshot,
  PrSnapshotFile,
  PrSnapshotRepositoryFile,
  ValidationCommand,
  ValidationHint,
  ValidationHintSource,
  ValidationPlan,
} from './types.js';

const VALIDATION_WORDS = /\b(test|lint|build|check|typecheck|verify|pytest|rspec)\b/i;
const TEST_PATH = /(^|\/)(tests?|spec|__tests__)(\/|$)|\.(test|spec)\.[^.]+$|_test\.[^.]+$|(^|\/)test_[^/]+\.py$/i;
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

function repositoryFiles(
  snapshot: PrSnapshot,
  includedFiles?: readonly string[],
): PrSnapshotRepositoryFile[] {
  const files = new Map(snapshot.repositoryFiles.map(file => [file.path, file]));
  const selected = includedFiles ? new Set(includedFiles) : null;
  for (const changed of snapshot.changedFiles) {
    const useHead = !selected || selected.has(changed.filename);
    files.delete(changed.filename);
    if (changed.previousFilename) files.delete(changed.previousFilename);
    if (useHead) {
      if (changed.status !== 'removed' && changed.headContent !== null) {
        files.set(changed.filename, {
          path: changed.filename,
          content: changed.headContent,
          contentComplete: changed.contentComplete,
        });
      }
    } else if (changed.status !== 'added' && changed.status !== 'copied' && changed.baseContent !== null) {
      const basePath = changed.previousFilename ?? changed.filename;
      files.set(basePath, {
        path: basePath,
        content: changed.baseContent,
        contentComplete: changed.contentComplete,
      });
    }
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
  if (manifest.contentComplete && manifest.content) {
    try {
      const parsed = JSON.parse(manifest.content) as { packageManager?: unknown };
      if (typeof parsed.packageManager === 'string') {
        const declared = parsed.packageManager.split('@', 1)[0];
        if (declared === 'npm' || declared === 'pnpm' || declared === 'yarn' || declared === 'bun') {
          return declared;
        }
      }
    } catch {
      // Script parsing will separately withhold commands from an invalid manifest.
    }
  }
  const path = manifest.path;
  const directories: string[] = [];
  let directory = posix.dirname(path);
  while (true) {
    directories.push(directory);
    if (directory === '.') break;
    directory = posix.dirname(directory);
  }
  for (const candidate of directories) {
    const names = files
      .filter(file => posix.dirname(file.path) === candidate)
      .map(file => posix.basename(file.path));
    if (names.some(name => /^pnpm-lock\.yaml$/i.test(name))) return 'pnpm';
    if (names.some(name => /^yarn\.lock$/i.test(name))) return 'yarn';
    if (names.some(name => /^bun\.lockb?$/i.test(name))) return 'bun';
    if (names.some(name => /^(?:package-lock\.json|npm-shrinkwrap\.json)$/i.test(name))) return 'npm';
  }
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
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
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
    reason: details.reason.normalize('NFKC')
      .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 1_000),
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
      .map(([name]) => name));
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
  const manifests = configs.filter(candidate => /(^|\/)package\.json$/i.test(candidate.path));
  const scriptCache = new Map(manifests.map(manifest => [manifest.path, parsedPackageScripts(manifest)]));
  const byManifestAndScript = new Map<string, { manifest: PrSnapshotRepositoryFile; script: string; files: PrSnapshotFile[] }>();
  for (const file of javascriptFiles) {
    const desired = new Set<string>();
    if (TEST_PATH.test(file.filename)) desired.add('test');
    if (/\.[cm]?tsx?$/i.test(file.filename)) desired.add('typecheck');
    for (const script of ['test', 'lint', 'build', 'check', 'verify']) desired.add(script);
    const ancestors = manifests
      .filter(manifest => isWithinDirectory(file.filename, posix.dirname(manifest.path)))
      .sort((left, right) => posix.dirname(right.path).length - posix.dirname(left.path).length);
    for (const script of SUPPORTED_PACKAGE_SCRIPTS.filter(name => desired.has(name))) {
      const manifest = ancestors.find(candidate => scriptCache.get(candidate.path)?.has(script));
      if (!manifest) continue;
      const key = `${manifest.path}\0${script}`;
      const existing = byManifestAndScript.get(key);
      byManifestAndScript.set(key, {
        manifest,
        script,
        files: [...(existing?.files ?? []), file],
      });
    }
  }
  for (const { manifest, script, files: related } of byManifestAndScript.values()) {
    addHint(hints, packageScriptCommand(packageManager(manifest, configs), script), {
      reason: `Allowlisted script declared in the scripts object of ${manifest.path}`,
      source: 'package-script',
      relatedFiles: related.map(file => file.filename),
      workingDirectory: posix.dirname(manifest.path),
      confidence: 'high',
      executable: true,
    });
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
    const config = configs.find(candidate => candidate.path === configPath);
    const contentUnavailable = config?.contentComplete === false;
    addHint(hints, details.command, {
      reason: contentUnavailable
        ? `${details.reason}; repository marker ${configPath} exists at the PR head, but its contents are unavailable`
        : `${details.reason}; repository marker ${configPath} exists at the PR head`,
      source: 'repository-convention',
      relatedFiles: paths,
      workingDirectory: posix.dirname(configPath),
      confidence: contentUnavailable ? 'low' : 'medium',
      executable: true,
    });
  }
}

function rubyHints(
  selectedFiles: PrSnapshotFile[],
  configs: readonly PrSnapshotRepositoryFile[],
  hints: ValidationHint[],
): void {
  for (const gemfile of configs.filter(file => posix.basename(file.path) === 'Gemfile')) {
    if (!gemfile.contentComplete
      || !/^\s*gem\s*\(?\s*['"]rspec(?:-core)?['"]/im.test(gemfile.content ?? '')) continue;
    const related = selectedFiles.filter(file => /\.rb$/i.test(file.filename)
      && isWithinDirectory(file.filename, posix.dirname(gemfile.path)));
    if (related.length === 0) continue;
    addHint(hints, 'bundle exec rspec', {
      reason: `RSpec is declared in ${gemfile.path}`,
      source: 'repository-convention',
      relatedFiles: related.map(file => file.filename),
      workingDirectory: posix.dirname(gemfile.path),
      confidence: 'high',
      executable: true,
    });
  }
}

function composerHasTestScript(content: string): boolean {
  try {
    const parsed = JSON.parse(content) as { scripts?: unknown };
    const scripts = typeof parsed.scripts === 'object' && parsed.scripts !== null
      ? parsed.scripts as Record<string, unknown>
      : null;
    const testScript = scripts?.test;
    return (typeof testScript === 'string' && Boolean(testScript.trim()))
      || (Array.isArray(testScript)
        && testScript.length > 0
        && testScript.every(entry => typeof entry === 'string'));
  } catch {
    return false;
  }
}

function phpHints(
  selectedFiles: PrSnapshotFile[],
  configs: readonly PrSnapshotRepositoryFile[],
  hints: ValidationHint[],
): void {
  for (const composer of configs.filter(file => posix.basename(file.path) === 'composer.json')) {
    if (!composer.contentComplete
      || composer.content === null
      || !composerHasTestScript(composer.content)) continue;
    const related = selectedFiles.filter(file => /\.php$/i.test(file.filename)
      && isWithinDirectory(file.filename, posix.dirname(composer.path)));
    if (related.length === 0) continue;
    addHint(hints, 'composer run-script test', {
      reason: `A test script is declared in ${composer.path}`,
      source: 'repository-convention',
      relatedFiles: related.map(file => file.filename),
      workingDirectory: posix.dirname(composer.path),
      confidence: 'high',
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
    extension: /\.java$/i, configName: /^pom\.xml$/i, command: 'mvn test', reason: 'Java source is selected',
  });
  addConvention(selectedFiles, configs, hints, {
    extension: /\.(?:java|kt|kts)$/i,
    configName: /^gradlew$/i,
    command: './gradlew test',
    reason: 'Gradle source is selected',
  });

  rubyHints(selectedFiles, configs, hints);
  phpHints(selectedFiles, configs, hints);

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

function annotateIncompleteRepositoryDiscovery(hints: ValidationHint[]): void {
  for (const hint of hints) {
    if (!hint.executable) continue;
    hint.confidence = 'low';
    hint.reason = `${hint.reason}; repository configuration discovery was incomplete`;
  }
}

/** Infer structured validation hints without executing untrusted repository code. */
export function inferValidationHints(
  snapshot: PrSnapshot,
  includedFiles?: readonly string[],
): ValidationPlan {
  const selectedFiles = selectedSnapshotFiles(snapshot, includedFiles);
  const configs = repositoryFiles(snapshot, includedFiles);
  const hints: ValidationHint[] = [];
  workflowObservations(selectedFiles, hints);
  javascriptHints(selectedFiles, configs, hints);
  languageHints(selectedFiles, configs, hints);
  if (!snapshot.repositoryTreeComplete) annotateIncompleteRepositoryDiscovery(hints);
  const commands: ValidationCommand[] = hints.filter(hint => hint.executable).map(hint => ({
    command: hint.command,
    workingDirectory: hint.workingDirectory,
    requiresSandbox: true,
  }));

  if (commands.length === 0) {
    const repositoryNote = snapshot.repositoryTreeComplete
      ? ''
      : ' Repository configuration discovery was incomplete.';
    return {
      commands: [],
      hints,
      inferred: false,
      explanation: `No constructed executable validation command could be inferred; manual validation is required.${repositoryNote}`,
    };
  }
  const unavailableConfigurationContents = hints.some(hint => hint.executable
    && /contents are unavailable/i.test(hint.reason));
  const incompleteReasons = [
    ...(!snapshot.repositoryTreeComplete ? ['repository configuration discovery was incomplete'] : []),
    ...(unavailableConfigurationContents ? ['relevant configuration contents were unavailable'] : []),
  ];
  if (incompleteReasons.length > 0) {
    return {
      commands,
      hints,
      inferred: false,
      explanation: `${commands.length} candidate validation command${commands.length === 1 ? ' was' : 's were'} constructed, but manual confirmation is required because ${incompleteReasons.join(' and ')}.`,
    };
  }
  return {
    commands,
    hints,
    inferred: true,
    explanation: `${commands.length} sandbox-required validation command${commands.length === 1 ? '' : 's'} inferred with repository-aware working directories.`,
  };
}

export const detectValidationHints = inferValidationHints;
