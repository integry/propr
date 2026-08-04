/* eslint-disable max-lines -- Candidate graph construction and safety checks form one deterministic pipeline. */
import { posix } from 'node:path';
import {
  addedSplitPatchText,
  isGeneratedSplitFile,
  isImplementationSplitFile,
  isSecretBearingSplitFile,
  isSpecialSplitDependencyFile,
  isTestSplitFile,
  normalizedSplitFileStem,
} from './candidateFileHeuristics.js';
import {
  buildCandidateRankingReasons,
  rankSplitCandidates,
  scoreSplitCandidate,
} from './candidateRanking.js';
import { inferValidationHints } from './validationHints.js';
import type {
  PrSnapshot,
  PrSnapshotFile,
  SplitCandidate,
  SplitCandidateKind,
  SplitCandidateSafetyAssessment,
} from './types.js';

interface CandidateSeed {
  kind: SplitCandidateKind;
  idPart: string;
  summary: string;
  files: string[];
  commitShas: string[];
}

type DependencyGraph = Map<string, Set<string>>;

interface ImportAliasRule {
  matchPrefix: string;
  matchSuffix: string;
  targetPrefix: string;
  targetSuffix: string;
}

const MAX_SPLIT_CANDIDATES = 128;
const MAX_COMMIT_SEEDS = 32;
const MAX_MODULE_SEEDS = 48;
const MAX_DEPENDENCY_SEEDS = 96;
const ANALYZABLE_SOURCE = /\.(?:[cm]?[jt]sx?|py|go|rs|rb|php|java|kt|kts|cs|cpp|cc|cxx|c|h|hpp|swift|scala|vue|svelte)$/i;
const DEPENDENCY_CONFIG = /(^|\/)(?:package\.json|pyproject\.toml|Cargo\.toml|Gemfile|composer\.json|go\.mod|Package\.swift)$/i;
const IMPORT_CONFIG = /(^|\/)(?:tsconfig(?:\.[^/]+)?|jsconfig)\.json$/i;
const RESOLVABLE_EXTENSIONS = [
  '.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs', '.py', '.go', '.rs',
  '.rb', '.php', '.java', '.kt', '.kts', '.cs', '.cpp', '.cc', '.cxx', '.c', '.h',
  '.hpp', '.swift', '.scala', '.vue', '.svelte', '.json', '.yaml', '.yml', '.css', '.scss',
  '.sass', '.less', '.svg', '.sql', '.proto', '.prisma',
];

const GENERIC_DIRECTORIES = new Set([
  'src', 'lib', 'app', 'test', 'tests', 'spec', 'services', 'components', 'controllers',
  'models', 'utils', 'helpers', 'hooks', 'pages', 'routes', 'packages', 'modules',
]);
const INSTRUCTION_STOP_WORDS = new Set([
  'split', 'extract', 'part', 'portion', 'change', 'changes', 'work', 'please', 'from',
  'into', 'with', 'only', 'related', 'the', 'and', 'for', 'this', 'that', 'pr',
]);

function isTestFile(filename: string): boolean {
  return isTestSplitFile(filename);
}

function isImplementationFile(filename: string): boolean {
  return isImplementationSplitFile(filename);
}

function changedFileMap(snapshot: PrSnapshot): Map<string, PrSnapshotFile> {
  return new Map(snapshot.changedFiles.map(file => [file.filename, file]));
}

function normalizedStem(filename: string): string {
  return normalizedSplitFileStem(filename);
}

function addDependency(graph: DependencyGraph, source: string, dependency: string): void {
  if (source === dependency || !graph.has(source) || !graph.has(dependency)) return;
  graph.get(source)?.add(dependency);
}

function addMandatoryCompanions(graph: DependencyGraph, left: string, right: string): void {
  addDependency(graph, left, right);
  addDependency(graph, right, left);
}

function pathAliases(snapshot: PrSnapshot): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const file of snapshot.changedFiles) {
    aliases.set(file.filename, file.filename);
    if (file.previousFilename) aliases.set(file.previousFilename, file.filename);
  }
  return aliases;
}

function configuredImportAliases(snapshot: PrSnapshot): ImportAliasRule[] {
  return snapshot.repositoryFiles.flatMap((file) => {
    if (!/(^|\/)(?:tsconfig(?:\.[^/]+)?|jsconfig)\.json$/i.test(file.path) || !file.contentComplete || !file.content) {
      return [];
    }
    try {
      const withoutComments = file.content
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
        .replace(/,\s*([}\]])/g, '$1');
      const parsed = JSON.parse(withoutComments) as {
        compilerOptions?: { baseUrl?: unknown; paths?: unknown };
      };
      const options = parsed.compilerOptions;
      if (!options || typeof options.paths !== 'object' || options.paths === null) return [];
      const baseUrl = typeof options.baseUrl === 'string' ? options.baseUrl : '.';
      return Object.entries(options.paths).flatMap(([pattern, targets]) => {
        if (!Array.isArray(targets)) return [];
        const wildcard = pattern.indexOf('*');
        const matchPrefix = wildcard >= 0 ? pattern.slice(0, wildcard) : pattern;
        const matchSuffix = wildcard >= 0 ? pattern.slice(wildcard + 1) : '';
        return targets.flatMap((target) => {
          if (typeof target !== 'string') return [];
          const targetWildcard = target.indexOf('*');
          const resolvedTarget = posix.normalize(posix.join(posix.dirname(file.path), baseUrl, target));
          return [{
            matchPrefix,
            matchSuffix,
            targetPrefix: targetWildcard >= 0 ? resolvedTarget.slice(0, resolvedTarget.indexOf('*')) : resolvedTarget,
            targetSuffix: targetWildcard >= 0 ? resolvedTarget.slice(resolvedTarget.indexOf('*') + 1) : '',
          }];
        });
      });
    } catch {
      return [];
    }
  });
}

function resolveChangedImport(
  fromFile: string,
  specifier: string,
  aliases: Map<string, string>,
  importAliases: readonly ImportAliasRule[],
): string[] {
  const pythonRelative = specifier.match(/^(\.+)([A-Za-z_].*)$/);
  const normalizedSpecifier = pythonRelative
    ? `${'../'.repeat(Math.max(0, pythonRelative[1].length - 1))}${pythonRelative[2].replace(/\./g, '/')}`
    : specifier
      .replace(/^crate::/, '')
      .replace(/^self::/, './')
      .replace(/^super::/, '../');
  const cleaned = normalizedSpecifier.trim()
    .replace(/[?#].*$/, '')
    .replace(/::/g, '/')
    .replace(/\\/g, '/')
    .replace(/^@\//, '')
    .replace(/^~\//, '')
    .replace(/\/\*$/, '');
  const relative = specifier.startsWith('.')
    || specifier.startsWith('self::')
    || specifier.startsWith('super::');
  const base = relative
    ? posix.normalize(posix.join(posix.dirname(fromFile), cleaned.replace(/^super::/, '../')))
    : cleaned.replace(/^\/+/, '').replace(/\./g, '/');
  const configuredBases = importAliases.flatMap((rule) => {
    if (!specifier.startsWith(rule.matchPrefix) || !specifier.endsWith(rule.matchSuffix)) return [];
    const matched = specifier.slice(
      rule.matchPrefix.length,
      specifier.length - rule.matchSuffix.length || undefined,
    );
    return [`${rule.targetPrefix}${matched}${rule.targetSuffix}`];
  });
  const bases = [...new Set([base, ...configuredBases])];
  if (/\.rs$/i.test(fromFile)) {
    let parent = posix.dirname(base);
    while (parent !== '.') {
      bases.push(parent);
      parent = posix.dirname(parent);
    }
  }
  const possibilities = bases.flatMap(candidate => [
    candidate,
    ...RESOLVABLE_EXTENSIONS.map(extension => `${candidate}${extension}`),
    ...RESOLVABLE_EXTENSIONS.map(extension => `${candidate}/index${extension}`),
    `${candidate}/__init__.py`,
  ]);
  const exact = possibilities.flatMap(path => aliases.get(path) ?? []);
  if (exact.length > 0) return [...new Set(exact)];

  // Package-qualified imports and common path aliases can still be matched
  // deterministically when their trailing path uniquely names a changed file.
  const suffixes = possibilities.map(path => `/${path}`);
  const suffixMatches = [...aliases.entries()]
    .filter(([path]) => suffixes.some(suffix => `/${path}`.endsWith(suffix))
      || (/\.go$/i.test(fromFile) && bases.some(candidate =>
        `/${posix.dirname(path)}`.endsWith(`/${candidate}`) && /\.go$/i.test(path))))
    .map(([, currentPath]) => currentPath);
  return [...new Set(suffixMatches)];
}

function referencedSpecifiers(filename: string, content: string): string[] {
  const patterns: RegExp[] = [];
  if (/\.(?:[cm]?[jt]sx?|vue|svelte)$/i.test(filename)) {
    patterns.push(
      /\b(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g,
      /\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    );
  } else if (/\.py$/i.test(filename)) {
    patterns.push(/^\s*from\s+([.\w]+)\s+import\s+/gm, /^\s*import\s+([.\w]+)/gm);
  } else if (/\.go$/i.test(filename)) {
    patterns.push(/^\s*(?:import\s+)?(?:[\w.]+\s+)?["`]([^"`]+)["`]/gm);
  } else if (/\.rs$/i.test(filename)) {
    patterns.push(/\buse\s+([\w:]+)/g, /\bmod\s+([A-Za-z_][\w]*)\s*;/g, /#\s*\[path\s*=\s*"([^"]+)"\]/g);
  } else if (/\.rb$/i.test(filename)) {
    patterns.push(/\b(?:require_relative|load)\s*\(?\s*['"]([^'"]+)['"]/g);
  } else if (/\.php$/i.test(filename)) {
    patterns.push(/\b(?:include|include_once|require|require_once)\s*\(?\s*['"]([^'"]+)['"]/g, /^\s*use\s+([\\\w]+)/gm);
  } else if (/\.(?:java|kt|kts|cs|swift|scala)$/i.test(filename)) {
    patterns.push(/^\s*import\s+([\w.*]+)/gm);
  } else if (/\.(?:c|cc|cpp|cxx|h|hpp)$/i.test(filename)) {
    patterns.push(/^\s*#\s*include\s*"([^"]+)"/gm);
  }
  return [...new Set(patterns.flatMap(pattern => [...content.matchAll(pattern)].map(match => match[1])))];
}

function importDependencies(snapshot: PrSnapshot, graph: DependencyGraph): void {
  const aliases = pathAliases(snapshot);
  const importAliases = configuredImportAliases(snapshot);
  for (const file of snapshot.changedFiles) {
    const versions = [
      { path: file.filename, content: file.headContent },
      { path: file.previousFilename ?? file.filename, content: file.baseContent },
    ];
    for (const version of versions) {
      if (version.content === null) continue;
      for (const specifier of referencedSpecifiers(version.path, version.content)) {
        for (const dependency of resolveChangedImport(version.path, specifier, aliases, importAliases)) {
          addMandatoryCompanions(graph, file.filename, dependency);
        }
      }
    }
  }
}

function testDependencies(snapshot: PrSnapshot, graph: DependencyGraph): void {
  const implementations = snapshot.changedFiles.filter(file => isImplementationFile(file.filename));
  for (const test of snapshot.changedFiles.filter(file => isTestFile(file.filename))) {
    const stem = normalizedStem(test.filename);
    const exact = implementations.filter(file => normalizedStem(file.filename) === stem);
    if (exact.length > 0) {
      const testDirectories = posix.dirname(test.filename).split('/');
      const ranked = exact.map(file => ({
        file,
        sharedDirectories: posix.dirname(file.filename).split('/')
          .filter(directory => testDirectories.includes(directory) && !GENERIC_DIRECTORIES.has(directory)).length,
      }));
      const bestScore = Math.max(...ranked.map(item => item.sharedDirectories));
      const nearest = ranked.filter(item => item.sharedDirectories === bestScore);
      if (nearest.length === 1 || bestScore > 0) {
        for (const { file } of nearest) addMandatoryCompanions(graph, test.filename, file.filename);
      }
      continue;
    }
    const pathToken = stem.length >= 4 ? stem : '';
    const related = implementations.filter(file => pathToken
      && posix.dirname(file.filename) === posix.dirname(test.filename)
      && file.filename.toLowerCase().split(/[^a-z0-9]+/).includes(pathToken));
    for (const implementation of related) {
      addMandatoryCompanions(graph, test.filename, implementation.filename);
    }
  }
}

function distinctiveTokens(file: PrSnapshotFile): Set<string> {
  const ignored = new Set(['const', 'string', 'return', 'function', 'create', 'update', 'delete', 'table']);
  return new Set(
    (file.headContent ?? addedSplitPatchText(file))
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter(token => token.length >= 5 && !ignored.has(token) && !/^\d+$/.test(token)),
  );
}

function specialDependencies(snapshot: PrSnapshot, graph: DependencyGraph): void {
  const specialFiles = snapshot.changedFiles.filter(file => isSpecialSplitDependencyFile(file.filename));
  const specialTokenMap = new Map(specialFiles.map(file => [file.filename, distinctiveTokens(file)]));
  for (const implementation of snapshot.changedFiles.filter(file => isImplementationFile(file.filename))) {
    const implementationTokens = distinctiveTokens(implementation);
    for (const dependency of specialFiles) {
      const shared = [...(specialTokenMap.get(dependency.filename) ?? [])]
        .filter(token => implementationTokens.has(token));
      // A shared schema/table/type identifier is strong evidence because these
      // files are already limited to changed migrations, schemas, and type contracts.
      if (shared.length >= 1) {
        addMandatoryCompanions(graph, implementation.filename, dependency.filename);
      }
    }
  }
}

function generatedCompanions(snapshot: PrSnapshot, graph: DependencyGraph): void {
  const generated = snapshot.changedFiles.filter(file => isGeneratedSplitFile(file.filename));
  const companionDirectory = (path: string): string => posix.dirname(path)
    .split('/')
    .filter(part => !['src', 'lib', 'dist', 'build', 'generated'].includes(part.toLowerCase()))
    .join('/') || '.';
  for (const source of snapshot.changedFiles.filter(file => !isGeneratedSplitFile(file.filename))) {
    for (const artifact of generated) {
      if (
        normalizedStem(source.filename) === normalizedStem(artifact.filename)
        && companionDirectory(source.filename) === companionDirectory(artifact.filename)
      ) {
        addMandatoryCompanions(graph, source.filename, artifact.filename);
      }
    }
  }
}

const MANIFEST_LOCK_NAMES: Record<string, readonly string[]> = {
  'package.json': ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb'],
  'pyproject.toml': ['poetry.lock', 'uv.lock'],
  'cargo.toml': ['cargo.lock'],
  gemfile: ['gemfile.lock'],
  'composer.json': ['composer.lock'],
  'go.mod': ['go.sum'],
  'package.swift': ['package.resolved'],
};

function manifestLockfileCompanions(snapshot: PrSnapshot, graph: DependencyGraph): void {
  const lowerPathMap = new Map(snapshot.changedFiles.map(file => [file.filename.toLowerCase(), file.filename]));
  for (const manifest of snapshot.changedFiles) {
    const name = posix.basename(manifest.filename).toLowerCase();
    const lockNames = MANIFEST_LOCK_NAMES[name];
    if (!lockNames) continue;
    let directory = posix.dirname(manifest.filename);
    while (true) {
      for (const lockName of lockNames) {
        const candidate = directory === '.' ? lockName : `${directory}/${lockName}`;
        const lockfile = lowerPathMap.get(candidate.toLowerCase());
        if (lockfile) addMandatoryCompanions(graph, manifest.filename, lockfile);
      }
      if (directory === '.') break;
      directory = posix.dirname(directory);
    }
  }
}

function buildDependencyGraph(snapshot: PrSnapshot): DependencyGraph {
  const graph: DependencyGraph = new Map(
    snapshot.changedFiles.map(file => [file.filename, new Set<string>()]),
  );
  importDependencies(snapshot, graph);
  testDependencies(snapshot, graph);
  specialDependencies(snapshot, graph);
  generatedCompanions(snapshot, graph);
  manifestLockfileCompanions(snapshot, graph);
  return graph;
}

function dependencyClosure(files: readonly string[], graph: DependencyGraph): string[] {
  const closure = new Set(files.filter(file => graph.has(file)));
  const queue = [...closure];
  for (let index = 0; index < queue.length; index += 1) {
    for (const dependency of graph.get(queue[index]) ?? []) {
      if (closure.has(dependency)) continue;
      closure.add(dependency);
      queue.push(dependency);
    }
  }
  return [...closure].sort();
}

function moduleKey(filename: string): string {
  const parsed = posix.parse(filename);
  const directories = parsed.dir.split('/').filter(Boolean);
  const lastDirectory = directories.at(-1)?.toLowerCase();
  if (directories.length === 0 || !lastDirectory || GENERIC_DIRECTORIES.has(lastDirectory)) {
    return [...directories, normalizedStem(filename)].join('/');
  }
  return directories.join('/');
}

function instructionTerms(instruction: string): string[] {
  const terms = instruction.toLowerCase().split(/[^a-z0-9]+/)
    .filter(term => term.length >= 3 && !INSTRUCTION_STOP_WORDS.has(term));
  const expanded = new Set(terms);
  if (terms.some(term => ['auth', 'authentication', 'authorization', 'login'].includes(term))) {
    for (const term of ['auth', 'authentication', 'authorization', 'login']) expanded.add(term);
  }
  return [...expanded];
}

function termMatches(text: string, term: string): boolean {
  if (term === 'auth') return /(^|[^a-z0-9])auth(?:entication|orization)?([^a-z0-9]|$)/i.test(text);
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}(?:s|es|ed|ing)?([^a-z0-9]|$)`, 'i').test(text);
}

function fileInstructionScore(file: PrSnapshotFile, terms: readonly string[]): number {
  const path = file.filename.toLowerCase();
  const patch = (file.patch ?? '').toLowerCase();
  return terms.reduce((score, term) => score
    + (termMatches(path, term) ? 5 : 0)
    + (termMatches(patch, term) ? 1 : 0), 0);
}

function candidateInstructionScore(
  snapshot: PrSnapshot,
  files: readonly string[],
  instruction: string,
): number {
  const terms = instructionTerms(instruction);
  if (terms.length === 0) return 0;
  const fileMap = changedFileMap(snapshot);
  let matchedTerms = 0;
  for (const term of terms) {
    const fileMatch = files.some(path => {
      const file = fileMap.get(path);
      return file ? fileInstructionScore(file, [term]) > 0 : false;
    });
    if (fileMatch) matchedTerms += 1;
  }
  return Math.round((matchedTerms / terms.length) * 100);
}

function instructionSeed(snapshot: PrSnapshot, instruction: string): CandidateSeed | null {
  const terms = instructionTerms(instruction);
  if (terms.length === 0) return null;
  const files = new Set(
    snapshot.changedFiles
      .filter(file => fileInstructionScore(file, terms) > 0)
      .map(file => file.filename),
  );
  const commitShas: string[] = [];
  for (const commit of snapshot.commits) {
    if (!terms.some(term => termMatches(commit.message.toLowerCase(), term))) continue;
    const independentlyMatched = commit.files.filter(path => {
      const file = changedFileMap(snapshot).get(path);
      return file ? fileInstructionScore(file, terms) > 0 : false;
    });
    if (independentlyMatched.length > 0) commitShas.push(commit.sha);
  }
  if (files.size === 0) return null;
  return {
    kind: 'instruction',
    idPart: 'requested',
    summary: `Requested scope: ${instruction.trim()}`,
    files: [...files],
    commitShas,
  };
}

function commitSeeds(snapshot: PrSnapshot): CandidateSeed[] {
  const changedPaths = new Set(snapshot.changedFiles.map(file => file.filename));
  const pathCommitCounts = new Map<string, number>();
  for (const commit of snapshot.commits) {
    for (const path of new Set(commit.files.filter(file => changedPaths.has(file)))) {
      pathCommitCounts.set(path, (pathCommitCounts.get(path) ?? 0) + 1);
    }
  }
  return snapshot.commits.flatMap(commit => {
    const files = commit.files.filter(file => changedPaths.has(file));
    if (
      files.length === 0
      || !commit.filesComplete
      || files.length !== new Set(commit.files).size
      || files.some(path => (pathCommitCounts.get(path) ?? 0) > 1)
    ) return [];
    return [{
      kind: 'atomic-commit' as const,
      idPart: commit.sha.slice(0, 12),
      summary: commit.title,
      files,
      commitShas: [commit.sha],
    }];
  });
}

function moduleSeeds(snapshot: PrSnapshot): CandidateSeed[] {
  const modules = new Map<string, string[]>();
  for (const file of snapshot.changedFiles) {
    const key = moduleKey(file.filename);
    modules.set(key, [...(modules.get(key) ?? []), file.filename]);
  }
  return [...modules.entries()].map(([key, files]) => ({
    kind: 'module-boundary',
    idPart: key,
    summary: `Cohesive module scope: ${key}`,
    files,
    commitShas: [],
  }));
}

function dependencySeeds(snapshot: PrSnapshot): CandidateSeed[] {
  return snapshot.changedFiles
    .filter(file => !isGeneratedSplitFile(file.filename) && !isSecretBearingSplitFile(file))
    .sort((left, right) => left.filename.localeCompare(right.filename))
    .slice(0, MAX_DEPENDENCY_SEEDS)
    .map(file => ({
      kind: 'dependency-closed' as const,
      idPart: file.filename,
      summary: `Smallest dependency-closed scope for ${file.filename}`,
      files: [file.filename],
      commitShas: [],
    }));
}

function dependencyAnalysisRejections(
  snapshot: PrSnapshot,
  selectedRecords: readonly PrSnapshotFile[],
): string[] {
  const reasons: string[] = [];
  const unsafeStatuses = selectedRecords.filter(file =>
    file.status === 'removed' || file.status === 'renamed' || file.status === 'unknown');
  if (unsafeStatuses.length > 0) {
    reasons.push(
      `Removed, renamed, or unknown-status files require repository-wide dependency validation before splitting: ${unsafeStatuses.map(file => file.filename).join(', ')}.`,
    );
  }
  const dependencyRelevantFiles = snapshot.changedFiles.filter(file =>
    ANALYZABLE_SOURCE.test(file.filename)
    || DEPENDENCY_CONFIG.test(file.filename)
    || isSpecialSplitDependencyFile(file.filename)
    || file.status === 'removed'
    || file.status === 'renamed');
  if (
    selectedRecords.some(file => dependencyRelevantFiles.includes(file))
    && dependencyRelevantFiles.some(file => !file.contentComplete)
  ) {
    const incomplete = dependencyRelevantFiles
      .filter(file => !file.contentComplete)
      .map(file => file.filename);
    reasons.push(`Complete base/head contents are unavailable for dependency analysis: ${incomplete.join(', ')}.`);
  }
  if (selectedRecords.some(file => ANALYZABLE_SOURCE.test(file.filename))) {
    const unreadableImportConfigs = snapshot.repositoryFiles
      .filter(file => IMPORT_CONFIG.test(file.path) && !file.contentComplete)
      .map(file => file.path);
    if (!snapshot.repositoryTreeComplete) {
      reasons.push('Repository tree discovery was incomplete, so path-alias dependency analysis cannot be trusted.');
    }
    if (unreadableImportConfigs.length > 0) {
      reasons.push(`Import configuration could not be read completely: ${unreadableImportConfigs.join(', ')}.`);
    }
  }
  return reasons;
}

function assessSafety(
  snapshot: PrSnapshot,
  includedFiles: readonly string[],
  graph: DependencyGraph,
): SplitCandidateSafetyAssessment {
  const fileMap = changedFileMap(snapshot);
  const selected = new Set(includedFiles);
  const rejectionReasons: string[] = [];
  const riskNotes: string[] = [];
  riskNotes.push('Automated secret detection is heuristic; publication must still enforce repository secret-scanning policy.');
  const dependencyFiles = [...selected]
    .flatMap(file => [...(graph.get(file) ?? [])])
    .filter((file, index, files) => !selected.has(file) && files.indexOf(file) === index)
    .sort();

  if (selected.size === 0) rejectionReasons.push('Candidate contains no changed files.');
  const unknownFiles = [...selected].filter(file => !fileMap.has(file));
  if (unknownFiles.length > 0) {
    rejectionReasons.push(`Candidate includes files outside the source PR: ${unknownFiles.join(', ')}.`);
  }
  if (selected.size >= snapshot.changedFiles.length) {
    rejectionReasons.push('Candidate contains the entire source PR and is not a focused split.');
  }
  const selectedRecords = [...selected].flatMap(path => fileMap.get(path) ?? []);
  if (selectedRecords.length > 0 && selectedRecords.every(file => isGeneratedSplitFile(file.filename))) {
    rejectionReasons.push('Candidate contains only generated artifacts or lockfiles.');
  }
  const secretFiles = selectedRecords.filter(isSecretBearingSplitFile).map(file => file.filename);
  if (secretFiles.length > 0) {
    rejectionReasons.push(`Candidate contains secret-bearing files: ${secretFiles.join(', ')}.`);
  }
  if (dependencyFiles.length > 0) {
    rejectionReasons.push(`Candidate depends on changed files outside the selected subset: ${dependencyFiles.join(', ')}.`);
  }
  rejectionReasons.push(...dependencyAnalysisRejections(snapshot, selectedRecords));
  const tests = selectedRecords.filter(file => isTestFile(file.filename));
  const implementations = selectedRecords.filter(file => isImplementationFile(file.filename));
  const sourcePrHasImplementation = snapshot.changedFiles.some(file => isImplementationFile(file.filename));
  if (tests.length > 0 && implementations.length === 0 && sourcePrHasImplementation) {
    rejectionReasons.push('Candidate contains tests without their changed implementation.');
  }
  if (!snapshot.sourceHeadRepository) {
    rejectionReasons.push('The source head repository is no longer available.');
  }
  const unscannableFiles = selectedRecords.filter(file => file.patch === null && !file.contentComplete);
  if (unscannableFiles.length > 0) {
    rejectionReasons.push(
      `GitHub did not provide a complete patch or file contents for: ${unscannableFiles.map(file => file.filename).join(', ')}.`,
    );
  }
  if (implementations.length > 0 && tests.length === 0) {
    riskNotes.push('No changed test file is included with the implementation scope.');
  }
  return {
    rejected: rejectionReasons.length > 0,
    rejectionReasons,
    riskNotes,
    missingDependencyFiles: dependencyFiles,
    safeToCreatePr: rejectionReasons.length === 0,
  };
}

function safeIdPart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64) || 'scope';
}

/** Build and rank split scopes. Dependencies are closed before any candidate is evaluated. */
export function buildSplitCandidates(snapshot: PrSnapshot, instruction = ''): SplitCandidate[] {
  const graph = buildDependencyGraph(snapshot);
  const requested = instructionSeed(snapshot, instruction);
  const seeds = [
    ...(requested ? [requested] : []),
    ...commitSeeds(snapshot).slice(0, MAX_COMMIT_SEEDS),
    ...moduleSeeds(snapshot).slice(0, MAX_MODULE_SEEDS),
    ...dependencySeeds(snapshot),
  ].slice(0, MAX_SPLIT_CANDIDATES * 2);
  const allFiles = snapshot.changedFiles.map(file => file.filename).sort();
  const snapshotFileMap = changedFileMap(snapshot);
  const signatures = new Set<string>();
  const usedIds = new Map<string, number>();
  const candidates: SplitCandidate[] = [];

  for (const seed of seeds) {
    if (candidates.length >= MAX_SPLIT_CANDIDATES) break;
    const includedFiles = dependencyClosure(seed.files, graph);
    const includedSet = new Set(includedFiles);
    const signature = includedFiles.join('\0');
    if (signatures.has(signature)) continue;
    signatures.add(signature);
    const baseId = `${seed.kind}-${safeIdPart(seed.idPart)}`;
    const occurrence = (usedIds.get(baseId) ?? 0) + 1;
    usedIds.set(baseId, occurrence);
    const safety = assessSafety(snapshot, includedFiles, graph);
    const validationPlan = inferValidationHints(snapshot, includedFiles);
    const candidate: SplitCandidate = {
      id: occurrence === 1 ? baseId : `${baseId}-${occurrence}`,
      kind: seed.kind,
      summary: seed.summary,
      includedFiles,
      excludedScope: allFiles.filter(file => !includedSet.has(file)),
      commitShas: [...new Set(seed.commitShas)].sort(),
      dependencyFiles: includedFiles.filter(file => !seed.files.includes(file)),
      instructionMatchScore: candidateInstructionScore(snapshot, includedFiles, instruction),
      changedLines: includedFiles.reduce(
        (total, path) => total + (snapshotFileMap.get(path)?.changes ?? 0),
        0,
      ),
      score: 0,
      rankingReasons: [],
      riskNotes: [
        ...safety.riskNotes,
        ...(validationPlan.inferred ? [] : [validationPlan.explanation]),
      ],
      validationPlan,
      rejected: safety.rejected,
      rejectionReasons: safety.rejectionReasons,
      safeToCreatePr: safety.safeToCreatePr,
    };
    candidate.rankingReasons = buildCandidateRankingReasons(candidate, instruction);
    candidate.score = scoreSplitCandidate(candidate);
    candidates.push(candidate);
  }
  return rankSplitCandidates(candidates);
}

export const constructSplitCandidates = buildSplitCandidates;

export { isGeneratedSplitFile, isSecretBearingSplitFile, rankSplitCandidates };

/** Public safety helper for callers that need to validate an externally stored subset. */
export function validateSplitCandidate(
  snapshot: PrSnapshot,
  includedFiles: readonly string[],
): SplitCandidateSafetyAssessment {
  return assessSafety(snapshot, includedFiles, buildDependencyGraph(snapshot));
}
