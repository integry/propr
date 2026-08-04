/* eslint-disable max-lines -- Candidate graph construction and safety checks form one deterministic pipeline. */
import { createHash } from 'node:crypto';
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
import { MAX_SPLIT_INSTRUCTION_LENGTH } from './command.js';
import {
  addLanguageImportDependencies,
  type LanguageDependencyAnalysis,
} from './dependencyResolvers.js';
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

interface DependencyAnalysisContext {
  graph: DependencyGraph;
  language: LanguageDependencyAnalysis;
  fileMap: Map<string, PrSnapshotFile>;
  dependencyRelevantPaths: Set<string>;
  incompleteDependencyPaths: string[];
  unreadableImportConfigs: string[];
}

type DependencyGraph = Map<string, Set<string>>;

const MAX_SPLIT_CANDIDATES = 128;
const MAX_INSTRUCTION_TERMS = 64;
const ANALYZABLE_SOURCE = /\.(?:[cm]?[jt]sx?|py|go|rs|rb|php|java|kt|kts|cs|cpp|cc|cxx|c|h|hpp|swift|scala|vue|svelte)$/i;
const DEPENDENCY_CONFIG = /(^|\/)(?:package\.json|pyproject\.toml|requirements[^/]*\.txt|setup\.py|setup\.cfg|Pipfile|Cargo\.toml|Gemfile|composer\.json|go\.mod|Package\.swift|pom\.xml|build\.gradle(?:\.kts)?|[^/]+\.(?:csproj|fsproj))$/i;
const IMPORT_CONFIG = /(^|\/)(?:tsconfig(?:\.[^/]+)?|jsconfig)\.json$/i;
const SOURCE_CONFIGURATION = /(^|\/)(?:package\.json|pyproject\.toml|requirements[^/]*\.txt|setup\.py|setup\.cfg|Pipfile|Cargo\.toml|Gemfile|composer\.json|go\.mod|Package\.swift|tsconfig(?:\.[^/]+)?\.json|jsconfig\.json|eslint\.config\.[cm]?js|\.eslintrc(?:\.[^/]+)?|vite\.config\.[cm]?[jt]s|webpack\.config\.[cm]?[jt]s|jest\.config\.[cm]?[jt]s|pom\.xml|build\.gradle(?:\.kts)?|[^/]+\.(?:csproj|fsproj))$/i;
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

function testDependencies(snapshot: PrSnapshot, graph: DependencyGraph): void {
  const implementations = snapshot.changedFiles.filter(file => isImplementationFile(file.filename));
  const implementationsByStem = new Map<string, PrSnapshotFile[]>();
  const implementationsByDirectoryToken = new Map<string, PrSnapshotFile[]>();
  for (const implementation of implementations) {
    const stem = normalizedStem(implementation.filename);
    implementationsByStem.set(stem, [...(implementationsByStem.get(stem) ?? []), implementation]);
    for (const token of implementation.filename.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
      const key = `${posix.dirname(implementation.filename)}\0${token}`;
      implementationsByDirectoryToken.set(key, [
        ...(implementationsByDirectoryToken.get(key) ?? []),
        implementation,
      ]);
    }
  }
  for (const test of snapshot.changedFiles.filter(file => isTestFile(file.filename))) {
    const stem = normalizedStem(test.filename);
    const exact = implementationsByStem.get(stem) ?? [];
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
        for (const { file } of nearest) addDependency(graph, test.filename, file.filename);
      }
      continue;
    }
    const pathToken = stem.length >= 4 ? stem : '';
    const related = pathToken
      ? implementationsByDirectoryToken.get(`${posix.dirname(test.filename)}\0${pathToken}`) ?? []
      : [];
    for (const implementation of related) {
      addDependency(graph, test.filename, implementation.filename);
    }
  }
}

function distinctiveTokens(file: PrSnapshotFile): Set<string> {
  const ignored = new Set([
    'changed', 'class', 'const', 'create', 'delete', 'export', 'extends', 'function',
    'import', 'interface', 'module', 'public', 'return', 'schema', 'select', 'string',
    'table', 'update', 'values', 'where',
  ]);
  return new Set(
    (file.headContent ?? addedSplitPatchText(file))
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter(token => token.length >= 6 && !ignored.has(token) && !/^\d+$/.test(token)),
  );
}

function declaredSpecialIdentifiers(file: PrSnapshotFile): Set<string> {
  const content = file.headContent ?? addedSplitPatchText(file);
  const patterns = [
    /\b(?:CREATE|ALTER)\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`[]?([A-Za-z_]\w*)/gi,
    /\b(?:interface|type|class|enum|message|model)\s+([A-Za-z_]\w*)/g,
  ];
  return new Set(patterns.flatMap(pattern => [...content.matchAll(pattern)]
    .map(match => match[1].toLowerCase())
    .filter(identifier => identifier.length >= 4)));
}

function specialDependencies(snapshot: PrSnapshot, graph: DependencyGraph): void {
  const specialFiles = snapshot.changedFiles.filter(file => isSpecialSplitDependencyFile(file.filename));
  const tokenFiles = new Map<string, Set<string>>();
  const declaredFiles = new Map<string, Set<string>>();
  for (const dependency of specialFiles) {
    for (const token of distinctiveTokens(dependency)) {
      const paths = tokenFiles.get(token) ?? new Set<string>();
      paths.add(dependency.filename);
      tokenFiles.set(token, paths);
    }
    if (!/(^|\/)migrations?(\/|$)|\.(?:sql|prisma|proto)$/i.test(dependency.filename)) continue;
    for (const identifier of declaredSpecialIdentifiers(dependency)) {
      const paths = declaredFiles.get(identifier) ?? new Set<string>();
      paths.add(dependency.filename);
      declaredFiles.set(identifier, paths);
    }
  }
  for (const implementation of snapshot.changedFiles.filter(file => isImplementationFile(file.filename))) {
    const implementationTokens = distinctiveTokens(implementation);
    const referencedIdentifiers = new Set(
      (implementation.headContent ?? addedSplitPatchText(implementation))
        .toLowerCase()
        .split(/[^a-z0-9_]+/)
        .filter(identifier => identifier.length >= 4),
    );
    const matchCounts = new Map<string, number>();
    for (const token of implementationTokens) {
      for (const path of tokenFiles.get(token) ?? []) {
        matchCounts.set(path, (matchCounts.get(path) ?? 0) + 1);
      }
    }
    for (const identifier of referencedIdentifiers) {
      for (const path of declaredFiles.get(identifier) ?? []) {
        addDependency(graph, implementation.filename, path);
      }
    }
    for (const [path, count] of matchCounts) {
      if (count >= 3) addDependency(graph, implementation.filename, path);
    }
  }
}

function generatedCompanions(snapshot: PrSnapshot, graph: DependencyGraph): void {
  const generated = snapshot.changedFiles.filter(file => isGeneratedSplitFile(file.filename));
  const companionDirectory = (path: string): string => posix.dirname(path)
    .split('/')
    .filter(part => !['src', 'lib', 'dist', 'build', 'generated'].includes(part.toLowerCase()))
    .join('/') || '.';
  const artifactsByKey = new Map<string, string[]>();
  for (const artifact of generated) {
    const key = `${companionDirectory(artifact.filename)}\0${normalizedStem(artifact.filename)}`;
    artifactsByKey.set(key, [...(artifactsByKey.get(key) ?? []), artifact.filename]);
  }
  for (const source of snapshot.changedFiles.filter(file => !isGeneratedSplitFile(file.filename))) {
    const key = `${companionDirectory(source.filename)}\0${normalizedStem(source.filename)}`;
    for (const artifact of artifactsByKey.get(key) ?? []) {
      addDependency(graph, source.filename, artifact);
    }
  }
}

const MANIFEST_LOCK_NAMES: Record<string, readonly string[]> = {
  'package.json': ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb'],
  'pyproject.toml': ['poetry.lock', 'uv.lock'],
  pipfile: ['Pipfile.lock'],
  'cargo.toml': ['cargo.lock'],
  gemfile: ['gemfile.lock'],
  'composer.json': ['composer.lock'],
  'go.mod': ['go.sum'],
  'package.swift': ['package.resolved'],
  'build.gradle': ['gradle.lockfile'],
  'build.gradle.kts': ['gradle.lockfile'],
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
        if (lockfile) addDependency(graph, manifest.filename, lockfile);
      }
      if (directory === '.') break;
      directory = posix.dirname(directory);
    }
  }
}

function configurationDependencies(snapshot: PrSnapshot, graph: DependencyGraph): void {
  const changedConfigs = snapshot.changedFiles.filter(file => SOURCE_CONFIGURATION.test(file.filename));
  const configsByDirectory = new Map<string, string[]>();
  for (const config of changedConfigs) {
    const directory = posix.dirname(config.filename);
    configsByDirectory.set(directory, [...(configsByDirectory.get(directory) ?? []), config.filename]);
  }
  for (const source of snapshot.changedFiles.filter(file => ANALYZABLE_SOURCE.test(file.filename))) {
    let directory = posix.dirname(source.filename);
    while (true) {
      for (const config of configsByDirectory.get(directory) ?? []) {
        addDependency(graph, source.filename, config);
      }
      if (directory === '.') break;
      directory = posix.dirname(directory);
    }
  }
}

function buildDependencyGraph(snapshot: PrSnapshot): DependencyAnalysisContext {
  const graph: DependencyGraph = new Map(
    snapshot.changedFiles.map(file => [file.filename, new Set<string>()]),
  );
  const language = addLanguageImportDependencies(
    snapshot,
    (left, right) => addDependency(graph, left, right),
  );
  testDependencies(snapshot, graph);
  specialDependencies(snapshot, graph);
  generatedCompanions(snapshot, graph);
  manifestLockfileCompanions(snapshot, graph);
  configurationDependencies(snapshot, graph);
  const dependencyRelevant = snapshot.changedFiles.filter(file =>
    ANALYZABLE_SOURCE.test(file.filename)
    || DEPENDENCY_CONFIG.test(file.filename)
    || SOURCE_CONFIGURATION.test(file.filename)
    || isSpecialSplitDependencyFile(file.filename)
    || file.status === 'removed'
    || file.status === 'renamed');
  return {
    graph,
    language,
    fileMap: changedFileMap(snapshot),
    dependencyRelevantPaths: new Set(dependencyRelevant.map(file => file.filename)),
    incompleteDependencyPaths: dependencyRelevant
      .filter(file => !file.contentComplete)
      .map(file => file.filename),
    unreadableImportConfigs: snapshot.repositoryFiles
      .filter(file => IMPORT_CONFIG.test(file.path) && !file.contentComplete)
      .map(file => file.path),
  };
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
  const terms = instruction.slice(0, MAX_SPLIT_INSTRUCTION_LENGTH).toLowerCase().split(/[^a-z0-9]+/)
    .filter(term => term.length >= 3 && !INSTRUCTION_STOP_WORDS.has(term))
    .slice(0, MAX_INSTRUCTION_TERMS);
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

function changedPatchLines(file: PrSnapshotFile): string[] {
  return (file.patch ?? '').split(/\r?\n/)
    .filter(line => (/^[+-]/.test(line) && !/^(?:\+\+\+|---)/.test(line)))
    .map(line => line.slice(1));
}

function filePatchHunks(file: PrSnapshotFile): string[] {
  if (!file.patch) return [];
  const hunks = file.patch.split(/(?=^@@)/m).filter(part => part.startsWith('@@'));
  return hunks.length > 0 ? hunks : [file.patch];
}

function candidateInstructionScore(
  fileMap: ReadonlyMap<string, PrSnapshotFile>,
  files: readonly string[],
  instruction: string,
): number {
  const terms = instructionTerms(instruction);
  if (terms.length === 0) return 0;
  let matchedTerms = 0;
  for (const term of terms) {
    const fileMatch = files.some(path => {
      const file = fileMap.get(path);
      return file ? fileInstructionScore(file, [term]) > 0 : false;
    });
    if (fileMatch) matchedTerms += 1;
  }
  const lines = files.flatMap((path) => {
    const record = fileMap.get(path);
    return record ? changedPatchLines(record) : [];
  });
  const matchedLines = lines.filter(line => terms.some(term => termMatches(line, term))).length;
  const termCoverage = matchedTerms / terms.length;
  const changedLinePurity = lines.length > 0 ? matchedLines / lines.length : 0;
  return Math.round(((termCoverage * 0.7) + (changedLinePurity * 0.3)) * 100);
}

function instructionPurityRejections(
  fileMap: ReadonlyMap<string, PrSnapshotFile>,
  files: readonly string[],
  instruction: string,
): string[] {
  const terms = instructionTerms(instruction);
  return files.flatMap((path) => {
    const record = fileMap.get(path);
    if (!record || terms.length === 0) return [];
    if (!record.patch || !record.patchComplete) {
      return [`Requested scope cannot be isolated safely because ${path} has no complete hunk evidence.`];
    }
    const hunks = filePatchHunks(record);
    if (hunks.length < 2) return [];
    const relevantHunks = hunks.filter(hunk => terms.some(term => termMatches(hunk, term))).length;
    const pathMatches = terms.some(term => termMatches(path, term));
    if ((relevantHunks > 0 && relevantHunks < hunks.length)
      || (pathMatches && relevantHunks < hunks.length)) {
      return [`Requested scope cannot be isolated at file level because ${path} contains unrelated changed hunks.`];
    }
    return [];
  });
}

function instructionSeed(snapshot: PrSnapshot, instruction: string): CandidateSeed | null {
  const boundedInstruction = instruction.slice(0, MAX_SPLIT_INSTRUCTION_LENGTH).trim();
  const terms = instructionTerms(boundedInstruction);
  if (terms.length === 0) return null;
  const fileMap = changedFileMap(snapshot);
  const files = new Set(
    snapshot.changedFiles
      .filter(file => fileInstructionScore(file, terms) > 0)
      .map(file => file.filename),
  );
  const commitShas: string[] = [];
  for (const commit of snapshot.commits) {
    if (!terms.some(term => termMatches(commit.message.slice(0, 2_000).toLowerCase(), term))) continue;
    const independentlyMatched = commit.files.filter(path => {
      const file = fileMap.get(path);
      return file ? fileInstructionScore(file, terms) > 0 : false;
    });
    if (independentlyMatched.length > 0) commitShas.push(commit.sha);
  }
  if (files.size === 0) return null;
  return {
    kind: 'instruction',
    idPart: 'requested',
    summary: `Requested scope: ${boundedInstruction}`,
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
      || commit.parents.length > 1
      || files.length !== new Set(commit.files).size
      || files.some(path => (pathCommitCounts.get(path) ?? 0) > 1)
    ) return [];
    return [{
      kind: 'atomic-commit' as const,
      idPart: commit.sha.slice(0, 12),
      summary: commit.title.slice(0, 500) || '(empty commit message)',
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
  return [...modules.entries()].sort(([left], [right]) => left.localeCompare(right, undefined, {
    numeric: true,
  })).map(([key, files]) => ({
    kind: 'module-boundary',
    idPart: key,
    summary: `Cohesive module scope: ${key}`,
    files,
    commitShas: [],
  }));
}

function dependencySeeds(snapshot: PrSnapshot): CandidateSeed[] {
  const eligible = snapshot.changedFiles
    .filter(file => !isGeneratedSplitFile(file.filename) && !isSecretBearingSplitFile(file))
    .sort((left, right) => left.filename.localeCompare(right.filename, undefined, { numeric: true }));
  return eligible.map(file => ({
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
  analysis: DependencyAnalysisContext,
): string[] {
  const {
    language, dependencyRelevantPaths, incompleteDependencyPaths, unreadableImportConfigs,
  } = analysis;
  const reasons: string[] = [];
  const unsafeStatuses = selectedRecords.filter(file =>
    file.status === 'removed' || file.status === 'renamed' || file.status === 'unknown');
  if (unsafeStatuses.length > 0) {
    reasons.push(
      `Removed, renamed, or unknown-status files require repository-wide dependency validation before splitting: ${unsafeStatuses.map(file => file.filename).join(', ')}.`,
    );
  }
  if (
    selectedRecords.some(file => dependencyRelevantPaths.has(file.filename))
    && incompleteDependencyPaths.length > 0
  ) {
    reasons.push(`Complete base/head contents are unavailable for dependency analysis: ${incompleteDependencyPaths.join(', ')}.`);
  }
  if (selectedRecords.some(file => ANALYZABLE_SOURCE.test(file.filename))) {
    const discoverySensitive = selectedRecords
      .filter(file => language.filesRequiringCompleteConfigDiscovery.has(file.filename));
    if (!snapshot.repositoryTreeComplete && discoverySensitive.length > 0) {
      reasons.push(`Repository configuration discovery was incomplete for non-relative imports in: ${discoverySensitive.map(file => file.filename).join(', ')}.`);
    }
    if (unreadableImportConfigs.length > 0) {
      reasons.push(`Import configuration could not be read completely: ${unreadableImportConfigs.join(', ')}.`);
    }
    if (language.incompleteReasons.length > 0) {
      reasons.push(...language.incompleteReasons);
    }
    const bestEffort = selectedRecords
      .filter(file => language.bestEffortFiles.has(file.filename))
      .map(file => file.filename);
    if (bestEffort.length > 0) {
      reasons.push(`Dependency resolution is best-effort for these language files and cannot establish a safe split: ${bestEffort.join(', ')}.`);
    }
  }
  return reasons;
}

function assessSafety(
  snapshot: PrSnapshot,
  includedFiles: readonly string[],
  analysis: DependencyAnalysisContext,
): SplitCandidateSafetyAssessment {
  const { graph, fileMap } = analysis;
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
  rejectionReasons.push(...dependencyAnalysisRejections(snapshot, selectedRecords, analysis));
  const tests = selectedRecords.filter(file => isTestFile(file.filename));
  const implementations = selectedRecords.filter(file => isImplementationFile(file.filename));
  if (!snapshot.sourceHeadRepository) {
    rejectionReasons.push('The source head repository is no longer available.');
  }
  const unscannableFiles = selectedRecords.filter(file => !file.contentComplete);
  if (unscannableFiles.length > 0) {
    rejectionReasons.push(
      `Complete file contents are unavailable, so dependency and secret scanning remain unknown for: ${unscannableFiles.map(file => file.filename).join(', ')}.`,
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

function sanitizedDisplayText(value: string, maximum = 1_000): string {
  return value.normalize('NFKC')
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maximum);
}

function sameStringSets(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every(value => rightSet.has(value));
}

function boundedRankedCandidates(
  candidates: readonly SplitCandidate[],
  maximum = MAX_SPLIT_CANDIDATES,
  requiredIds: ReadonlySet<string> = new Set(),
): SplitCandidate[] {
  const ranked = rankSplitCandidates(candidates);
  if (ranked.length <= maximum) return ranked;
  const required = ranked.filter(candidate => requiredIds.has(candidate.id)).slice(0, maximum);
  const selectedIds = new Set(required.map(candidate => candidate.id));
  const leadingCount = Math.floor((maximum - required.length) * 0.75);
  const leading = ranked.filter(candidate => !selectedIds.has(candidate.id)).slice(0, leadingCount);
  const selected = [...required, ...leading];
  for (const candidate of leading) selectedIds.add(candidate.id);
  const remainder = candidates.filter(candidate => !selectedIds.has(candidate.id));
  const sampleCount = maximum - selected.length;
  const indices = new Set(Array.from(
    { length: sampleCount },
    (_, index) => sampleCount === 1
      ? 0
      : Math.round((index * (remainder.length - 1)) / (sampleCount - 1)),
  ));
  selected.push(...[...indices].map(index => remainder[index]));
  return rankSplitCandidates(selected);
}

function pendingValidationPlan(): SplitCandidate['validationPlan'] {
  return {
    commands: [],
    hints: [],
    inferred: false,
    explanation: 'Validation inference is pending candidate bounding.',
  };
}

/** Build and rank split scopes. Dependencies are closed before any candidate is evaluated. */
export function buildSplitCandidates(snapshot: PrSnapshot, instruction = ''): SplitCandidate[] {
  const boundedInstruction = instruction.slice(0, MAX_SPLIT_INSTRUCTION_LENGTH).trim();
  const analysis = buildDependencyGraph(snapshot);
  const { graph } = analysis;
  const requested = instructionSeed(snapshot, boundedInstruction);
  const seeds = [
    ...(requested ? [requested] : []),
    ...commitSeeds(snapshot),
    ...moduleSeeds(snapshot),
    ...dependencySeeds(snapshot),
  ];
  const allFiles = snapshot.changedFiles.map(file => file.filename).sort();
  const snapshotFileMap = analysis.fileMap;
  const signatures = new Set<string>();
  const usedIds = new Set<string>();
  const candidates: SplitCandidate[] = [];

  for (const seed of seeds) {
    const includedFiles = dependencyClosure(seed.files, graph);
    const includedSet = new Set(includedFiles);
    const signature = includedFiles.join('\0');
    if (signatures.has(signature)) continue;
    signatures.add(signature);
    const expandedAtomicCommit = seed.kind === 'atomic-commit'
      && !sameStringSets(includedFiles, seed.files);
    const effectiveKind: SplitCandidateKind = expandedAtomicCommit
      ? 'dependency-closed'
      : seed.kind;
    const effectiveSummary = expandedAtomicCommit
      ? `Dependency-closed expansion of commit: ${seed.summary}`
      : seed.summary;
    const baseId = `${effectiveKind}-${safeIdPart(seed.idPart)}`;
    const signatureHash = createHash('sha256').update(signature).digest('hex').slice(0, 12);
    let id = `${baseId}-${signatureHash}`;
    let collision = 2;
    while (usedIds.has(id)) {
      id = `${baseId}-${signatureHash}-${collision}`;
      collision += 1;
    }
    usedIds.add(id);
    const safety = assessSafety(snapshot, includedFiles, analysis);
    const instructionScore = candidateInstructionScore(
      snapshotFileMap,
      includedFiles,
      boundedInstruction,
    );
    const purityRejections = boundedInstruction && instructionScore > 0
      ? instructionPurityRejections(snapshotFileMap, includedFiles, boundedInstruction)
      : [];
    const rejectionReasons = [...safety.rejectionReasons, ...purityRejections]
      .map(reason => sanitizedDisplayText(reason, 2_000));
    const validationPlan = pendingValidationPlan();
    const candidate: SplitCandidate = {
      id,
      kind: effectiveKind,
      summary: sanitizedDisplayText(effectiveSummary, 600),
      includedFiles,
      excludedScope: includedSet.size < allFiles.length ? ['(deferred)'] : [],
      commitShas: expandedAtomicCommit ? [] : [...new Set(seed.commitShas)].sort(),
      dependencyFiles: includedFiles.filter(file => !seed.files.includes(file)),
      instructionMatchScore: instructionScore,
      changedLines: includedFiles.reduce(
        (total, path) => total + (snapshotFileMap.get(path)?.changes ?? 0),
        0,
      ),
      score: 0,
      rankingReasons: [],
      riskNotes: [
        ...safety.riskNotes,
      ].map(note => sanitizedDisplayText(note, 2_000)),
      validationPlan,
      rejected: rejectionReasons.length > 0,
      rejectionReasons,
      safeToCreatePr: rejectionReasons.length === 0,
    };
    candidate.rankingReasons = buildCandidateRankingReasons(candidate, boundedInstruction);
    candidate.score = scoreSplitCandidate(candidate);
    candidates.push(candidate);
  }
  const requiredIds = new Set(candidates.at(-1) ? [candidates.at(-1)!.id] : []);
  const preliminary = boundedRankedCandidates(
    candidates,
    MAX_SPLIT_CANDIDATES * 2,
    requiredIds,
  );
  const validationCache = new Map<string, SplitCandidate['validationPlan']>();
  const completed = preliminary.map((candidate) => {
    const signature = candidate.includedFiles.join('\0');
    let validationPlan = validationCache.get(signature);
    if (!validationPlan) {
      validationPlan = inferValidationHints(snapshot, candidate.includedFiles);
      validationCache.set(signature, validationPlan);
    }
    const includedSet = new Set(candidate.includedFiles);
    const completedCandidate: SplitCandidate = {
      ...candidate,
      excludedScope: allFiles.filter(file => !includedSet.has(file)),
      riskNotes: [
        ...candidate.riskNotes,
        ...(validationPlan.inferred ? [] : [validationPlan.explanation]),
      ].map(note => sanitizedDisplayText(note, 2_000)),
      validationPlan,
    };
    completedCandidate.rankingReasons = buildCandidateRankingReasons(
      completedCandidate,
      boundedInstruction,
    );
    completedCandidate.score = scoreSplitCandidate(completedCandidate);
    return completedCandidate;
  });
  return boundedRankedCandidates(completed, MAX_SPLIT_CANDIDATES, requiredIds);
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
