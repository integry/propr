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

const GENERIC_DIRECTORIES = new Set([
  'src', 'lib', 'app', 'test', 'tests', 'spec', 'services', 'components', 'controllers',
  'models', 'utils', 'helpers', 'hooks', 'pages', 'routes',
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

function resolveChangedImport(
  fromFile: string,
  specifier: string,
  files: Set<string>,
): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = posix.normalize(posix.join(posix.dirname(fromFile), specifier));
  const possibilities = [
    base,
    ...['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.py'].map(extension => `${base}${extension}`),
    ...['.ts', '.tsx', '.js', '.jsx', '.py'].map(extension => `${base}/index${extension}`),
  ];
  return possibilities.find(path => files.has(path)) ?? null;
}

function importDependencies(snapshot: PrSnapshot, graph: DependencyGraph): void {
  const paths = new Set(graph.keys());
  const importPattern = /(?:\bfrom\s+|\bimport\s*\(|\brequire\s*\()\s*['"]([^'"]+)['"]/g;
  for (const file of snapshot.changedFiles) {
    if (!file.patch) continue;
    const currentPatchText = file.patch
      .split(/\r?\n/)
      .filter(line => !line.startsWith('-'))
      .join('\n');
    for (const match of currentPatchText.matchAll(importPattern)) {
      const dependency = resolveChangedImport(file.filename, match[1], paths);
      if (dependency) addDependency(graph, file.filename, dependency);
    }
  }
}

function testDependencies(snapshot: PrSnapshot, graph: DependencyGraph): void {
  const implementations = snapshot.changedFiles.filter(file => isImplementationFile(file.filename));
  for (const test of snapshot.changedFiles.filter(file => isTestFile(file.filename))) {
    const stem = normalizedStem(test.filename);
    const exact = implementations.filter(file => normalizedStem(file.filename) === stem);
    if (exact.length > 0) {
      for (const implementation of exact) addDependency(graph, test.filename, implementation.filename);
      continue;
    }
    const pathToken = stem.length >= 3 ? stem : '';
    const related = implementations.filter(file => pathToken
      && file.filename.toLowerCase().split(/[^a-z0-9]+/).includes(pathToken));
    for (const implementation of related) addDependency(graph, test.filename, implementation.filename);
  }
}

function distinctiveTokens(file: PrSnapshotFile): Set<string> {
  const ignored = new Set(['const', 'string', 'return', 'function', 'create', 'update', 'delete', 'table']);
  return new Set(
    addedSplitPatchText(file)
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter(token => token.length >= 5 && !ignored.has(token) && !/^\d+$/.test(token)),
  );
}

function specialDependencies(snapshot: PrSnapshot, graph: DependencyGraph): void {
  const fileMap = changedFileMap(snapshot);
  const specialFiles = snapshot.changedFiles.filter(file => isSpecialSplitDependencyFile(file.filename));
  for (const commit of snapshot.commits) {
    const commitFiles = commit.files.map(path => fileMap.get(path)).filter((file): file is PrSnapshotFile => Boolean(file));
    const dependencies = commitFiles.filter(file => isSpecialSplitDependencyFile(file.filename));
    const implementations = commitFiles.filter(file => isImplementationFile(file.filename));
    for (const implementation of implementations) {
      for (const dependency of dependencies) addDependency(graph, implementation.filename, dependency.filename);
    }
  }

  const specialTokenMap = new Map(specialFiles.map(file => [file.filename, distinctiveTokens(file)]));
  for (const implementation of snapshot.changedFiles.filter(file => isImplementationFile(file.filename))) {
    const implementationTokens = distinctiveTokens(implementation);
    for (const dependency of specialFiles) {
      const shared = [...(specialTokenMap.get(dependency.filename) ?? [])]
        .filter(token => implementationTokens.has(token));
      // A shared schema/table/type identifier is strong evidence because these
      // files are already limited to changed migrations, schemas, and type contracts.
      if (shared.length >= 1) addDependency(graph, implementation.filename, dependency.filename);
    }
  }
}

function generatedCompanions(snapshot: PrSnapshot, graph: DependencyGraph): void {
  const generated = snapshot.changedFiles.filter(file => isGeneratedSplitFile(file.filename));
  for (const source of snapshot.changedFiles.filter(file => !isGeneratedSplitFile(file.filename))) {
    for (const artifact of generated) {
      if (normalizedStem(source.filename) === normalizedStem(artifact.filename)) {
        addDependency(graph, source.filename, artifact.filename);
      }
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
    .filter(term => term.length >= 2 && !INSTRUCTION_STOP_WORDS.has(term));
  const expanded = new Set(terms);
  if (terms.some(term => ['auth', 'authentication', 'authorization', 'login'].includes(term))) {
    for (const term of ['auth', 'authentication', 'authorization', 'login']) expanded.add(term);
  }
  return [...expanded];
}

function termMatches(text: string, term: string): boolean {
  if (term === 'auth') return /(^|[^a-z0-9])auth(?:entication|orization)?([^a-z0-9]|$)/i.test(text);
  return text.includes(term);
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
  const selected = new Set(files);
  let matchedTerms = 0;
  for (const term of terms) {
    const fileMatch = files.some(path => {
      const file = fileMap.get(path);
      return file ? fileInstructionScore(file, [term]) > 0 : false;
    });
    const commitMatch = snapshot.commits.some(commit =>
      commit.files.some(path => selected.has(path)) && termMatches(commit.message.toLowerCase(), term));
    if (fileMatch || commitMatch) matchedTerms += 1;
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
    commitShas.push(commit.sha);
    for (const file of commit.files) files.add(file);
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
  return snapshot.commits.flatMap(commit => {
    const files = commit.files.filter(file => changedPaths.has(file));
    if (files.length === 0) return [];
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
    .map(file => ({
      kind: 'dependency-closed' as const,
      idPart: file.filename,
      summary: `Smallest dependency-closed scope for ${file.filename}`,
      files: [file.filename],
      commitShas: [],
    }));
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
  const tests = selectedRecords.filter(file => isTestFile(file.filename));
  const implementations = selectedRecords.filter(file => isImplementationFile(file.filename));
  const sourcePrHasImplementation = snapshot.changedFiles.some(file => isImplementationFile(file.filename));
  if (tests.length > 0 && implementations.length === 0 && sourcePrHasImplementation) {
    rejectionReasons.push('Candidate contains tests without their changed implementation.');
  }
  if (!snapshot.sourceHeadRepository) {
    rejectionReasons.push('The source head repository is no longer available.');
  }
  if (selectedRecords.some(file => file.patch === null)) {
    riskNotes.push('GitHub did not provide a patch for every selected file; dependency analysis may be incomplete.');
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
    ...commitSeeds(snapshot),
    ...moduleSeeds(snapshot),
    ...dependencySeeds(snapshot),
  ];
  const allFiles = snapshot.changedFiles.map(file => file.filename).sort();
  const signatures = new Set<string>();
  const usedIds = new Map<string, number>();
  const candidates: SplitCandidate[] = [];

  for (const seed of seeds) {
    const includedFiles = dependencyClosure(seed.files, graph);
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
      excludedScope: allFiles.filter(file => !includedFiles.includes(file)),
      commitShas: [...new Set(seed.commitShas)].sort(),
      dependencyFiles: includedFiles.filter(file => !seed.files.includes(file)),
      instructionMatchScore: candidateInstructionScore(snapshot, includedFiles, instruction),
      score: 0,
      rankingReasons: [],
      riskNotes: [
        ...safety.riskNotes,
        ...(validationPlan.inferred ? [] : [validationPlan.explanation]),
      ],
      validationPlan,
      rejected: safety.rejected,
      rejectionReasons: safety.rejectionReasons,
      safeToCreatePr: !safety.rejected,
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
