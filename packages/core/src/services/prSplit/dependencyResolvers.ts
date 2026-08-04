import { posix } from 'node:path';
import type { PrSnapshot } from './types.js';

interface ImportAliasRule {
  matchPrefix: string;
  matchSuffix: string;
  targetPrefix: string;
  targetSuffix: string;
  wildcard: boolean;
  appliesWithin: string;
}

interface WorkspacePackage {
  name: string;
  directory: string;
  entrypoints: Map<string, string[]>;
}

interface ImportResolutionContext {
  fromFile: string;
  specifier: string;
  changedPathAliases: Map<string, string>;
  importAliases: readonly ImportAliasRule[];
  packages: readonly WorkspacePackage[];
}

interface SpecifierAdapter {
  supports: RegExp;
  patterns: readonly RegExp[];
}

export interface LanguageDependencyAnalysis {
  incompleteReasons: string[];
  filesRequiringCompleteConfigDiscovery: Set<string>;
  bestEffortFiles: Set<string>;
}

type RepositoryVersion = 'base' | 'head';

const RESOLVABLE_EXTENSIONS = [
  '.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs', '.py', '.go', '.rs',
  '.rb', '.php', '.java', '.kt', '.kts', '.cs', '.cpp', '.cc', '.cxx', '.c', '.h',
  '.hpp', '.swift', '.scala', '.vue', '.svelte', '.json', '.yaml', '.yml', '.css', '.scss',
  '.sass', '.less', '.svg', '.sql', '.proto', '.prisma',
];

const SPECIFIER_ADAPTERS: readonly SpecifierAdapter[] = [
  {
    supports: /\.(?:[cm]?[jt]sx?|vue|svelte)$/i,
    patterns: [
      /\b(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g,
      /\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    ],
  },
  {
    supports: /\.py$/i,
    patterns: [/^\s*from\s+([.\w]+)\s+import\s+/gm, /^\s*import\s+([.\w]+)/gm],
  },
  {
    supports: /\.go$/i,
    patterns: [/^\s*(?:import\s+)?(?:[\w.]+\s+)?["`]([^"`]+)["`]/gm],
  },
  {
    supports: /\.rs$/i,
    patterns: [/\buse\s+([\w:]+)/g, /\bmod\s+([A-Za-z_][\w]*)\s*;/g, /#\s*\[path\s*=\s*"([^"]+)"\]/g],
  },
  {
    supports: /\.rb$/i,
    patterns: [/\b(?:require_relative|require|load)\s*\(?\s*['"]([^'"]+)['"]/g],
  },
  {
    supports: /\.php$/i,
    patterns: [/\b(?:include|include_once|require|require_once)\s*\(?\s*['"]([^'"]+)['"]/g, /^\s*use\s+([\\\w]+)/gm],
  },
  {
    supports: /\.(?:java|kt|kts|swift|scala)$/i,
    patterns: [/^\s*import\s+([\w.*]+)/gm],
  },
  {
    supports: /\.cs$/i,
    patterns: [/^\s*(?:global\s+)?using\s+(?:static\s+)?(?:[A-Za-z_]\w*\s*=\s*)?([\w.]+)\s*;/gm],
  },
  {
    supports: /\.(?:c|cc|cpp|cxx|h|hpp)$/i,
    patterns: [/^\s*#\s*include\s*"([^"]+)"/gm],
  },
];

function repositoryAnalysisFiles(snapshot: PrSnapshot, version: RepositoryVersion): Array<{
  path: string;
  content: string | null;
  contentComplete: boolean;
}> {
  const files = new Map(snapshot.repositoryFiles.map(file => [file.path, file]));
  for (const changed of snapshot.changedFiles) {
    files.delete(changed.filename);
    if (changed.previousFilename) files.delete(changed.previousFilename);
    const isHead = version === 'head';
    const path = isHead ? changed.filename : (changed.previousFilename ?? changed.filename);
    const content = isHead ? changed.headContent : changed.baseContent;
    const absent = isHead
      ? changed.status === 'removed'
      : changed.status === 'added' || changed.status === 'copied';
    if (absent || content === null) continue;
    files.set(path, { path, content, contentComplete: changed.contentComplete });
  }
  return [...files.values()];
}

function stripJsonc(value: string): string {
  let output = '';
  let quote = '';
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    const next = value[index + 1];
    if (quote) {
      output += character;
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = '';
      continue;
    }
    if (character === '"') {
      quote = character;
      output += character;
      continue;
    }
    if (character === '/' && next === '/') {
      while (index < value.length && value[index] !== '\n') index += 1;
      output += '\n';
      continue;
    }
    if (character === '/' && next === '*') {
      index += 2;
      while (index < value.length && !(value[index] === '*' && value[index + 1] === '/')) {
        if (value[index] === '\n') output += '\n';
        index += 1;
      }
      index += 1;
      continue;
    }
    output += character;
  }
  return output.replace(/,\s*([}\]])/g, '$1');
}

function aliasRules(
  pattern: string,
  targets: unknown,
  directory: string,
  baseUrl = '.',
): ImportAliasRule[] {
  if (!Array.isArray(targets)) return [];
  const wildcard = pattern.indexOf('*');
  return targets.flatMap((target) => {
    if (typeof target !== 'string') return [];
    const targetWildcard = target.indexOf('*');
    const resolvedTarget = posix.normalize(posix.join(directory, baseUrl, target));
    return [{
      matchPrefix: wildcard >= 0 ? pattern.slice(0, wildcard) : pattern,
      matchSuffix: wildcard >= 0 ? pattern.slice(wildcard + 1) : '',
      targetPrefix: targetWildcard >= 0
        ? resolvedTarget.slice(0, resolvedTarget.indexOf('*'))
        : resolvedTarget,
      targetSuffix: targetWildcard >= 0
        ? resolvedTarget.slice(resolvedTarget.indexOf('*') + 1)
        : '',
      wildcard: wildcard >= 0,
      appliesWithin: directory,
    }];
  });
}

function configuredImportAliases(files: ReturnType<typeof repositoryAnalysisFiles>): {
  rules: ImportAliasRule[];
  errors: string[];
} {
  const rules: ImportAliasRule[] = [];
  const errors: string[] = [];
  for (const file of files) {
    const isTsConfig = /(^|\/)(?:tsconfig(?:\.[^/]+)?|jsconfig)\.json$/i.test(file.path);
    const isPackage = posix.basename(file.path) === 'package.json';
    if (!isTsConfig && !isPackage) continue;
    if (!file.contentComplete || !file.content) continue;
    try {
      const parsed = JSON.parse(isTsConfig ? stripJsonc(file.content) : file.content) as {
        compilerOptions?: { baseUrl?: unknown; paths?: unknown };
        imports?: unknown;
      };
      const directory = posix.dirname(file.path);
      if (isTsConfig) {
        const options = parsed.compilerOptions;
        if (options && typeof options.paths === 'object' && options.paths !== null) {
          const baseUrl = typeof options.baseUrl === 'string' ? options.baseUrl : '.';
          for (const [pattern, targets] of Object.entries(options.paths)) {
            rules.push(...aliasRules(pattern, targets, directory, baseUrl));
          }
        }
      } else if (typeof parsed.imports === 'object' && parsed.imports !== null) {
        for (const [pattern, targets] of Object.entries(parsed.imports)) {
          rules.push(...aliasRules(pattern, packageTargets(targets), directory));
        }
      }
    } catch (error) {
      errors.push(`Import configuration ${file.path} could not be parsed: ${(error as Error).message}`);
    }
  }
  return { rules, errors };
}

function packageTargets(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(packageTargets);
  if (typeof value !== 'object' || value === null) return [];
  return Object.values(value).flatMap(packageTargets);
}

function workspacePackages(files: ReturnType<typeof repositoryAnalysisFiles>): {
  packages: WorkspacePackage[];
  errors: string[];
} {
  const packages: WorkspacePackage[] = [];
  const errors: string[] = [];
  for (const file of files) {
    if (posix.basename(file.path) !== 'package.json' || !file.contentComplete || !file.content) continue;
    try {
      const parsed = JSON.parse(file.content) as Record<string, unknown>;
      if (typeof parsed.name !== 'string' || !parsed.name.trim()) continue;
      const directory = posix.dirname(file.path);
      const entrypoints = new Map<string, string[]>();
      const exportsValue = parsed.exports;
      if (typeof exportsValue === 'string' || Array.isArray(exportsValue)) {
        entrypoints.set('.', packageTargets(exportsValue));
      } else if (typeof exportsValue === 'object' && exportsValue !== null) {
        for (const [key, value] of Object.entries(exportsValue)) {
          if (key === '.' || key.startsWith('./')) entrypoints.set(key, packageTargets(value));
        }
      }
      const rootTargets = ['types', 'typings', 'module', 'main']
        .flatMap(key => typeof parsed[key] === 'string' ? [parsed[key] as string] : []);
      if (rootTargets.length > 0) {
        entrypoints.set('.', [...(entrypoints.get('.') ?? []), ...rootTargets]);
      }
      packages.push({ name: parsed.name.trim(), directory, entrypoints });
    } catch (error) {
      errors.push(`Workspace manifest ${file.path} could not be parsed: ${(error as Error).message}`);
    }
  }
  return { packages, errors };
}

function configuredBases(context: ImportResolutionContext): string[] {
  const matches = context.importAliases.filter(rule => (rule.appliesWithin === '.'
      || context.fromFile.startsWith(`${rule.appliesWithin}/`))
    && (rule.wildcard
      ? context.specifier.startsWith(rule.matchPrefix)
        && context.specifier.endsWith(rule.matchSuffix)
      : context.specifier === rule.matchPrefix));
  const nearestDepth = Math.max(-1, ...matches.map(rule => rule.appliesWithin.length));
  return matches.filter(rule => rule.appliesWithin.length === nearestDepth).flatMap((rule) => {
    if (!rule.wildcard) return [rule.targetPrefix];
    const matched = context.specifier.slice(
      rule.matchPrefix.length,
      context.specifier.length - rule.matchSuffix.length || undefined,
    );
    return [`${rule.targetPrefix}${matched}${rule.targetSuffix}`];
  });
}

function workspaceBases(context: ImportResolutionContext): string[] {
  return context.packages.flatMap((workspace) => {
    if (context.specifier !== workspace.name
      && !context.specifier.startsWith(`${workspace.name}/`)) return [];
    const subpath = context.specifier === workspace.name
      ? '.'
      : `./${context.specifier.slice(workspace.name.length + 1)}`;
    const exported = [
      ...(workspace.entrypoints.get(subpath) ?? []),
      ...[...workspace.entrypoints.entries()].flatMap(([pattern, targets]) => {
        const wildcard = pattern.indexOf('*');
        if (wildcard < 0) return [];
        const prefix = pattern.slice(0, wildcard);
        const suffix = pattern.slice(wildcard + 1);
        if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix)) return [];
        const matched = subpath.slice(prefix.length, subpath.length - suffix.length || undefined);
        return targets.map(target => target.replace('*', matched));
      }),
    ];
    const fallback = subpath === '.' ? [] : [subpath.slice(2)];
    return [...exported, ...fallback]
      .map(target => posix.normalize(posix.join(workspace.directory, target)));
  });
}

function resolveChangedImport(context: ImportResolutionContext): string[] {
  const { fromFile, specifier, changedPathAliases } = context;
  const pythonRelative = specifier.match(/^(\.+)([A-Za-z_].*)$/);
  const normalizedSpecifier = pythonRelative
    ? `${'../'.repeat(Math.max(0, pythonRelative[1].length - 1))}${pythonRelative[2].replace(/\./g, '/')}`
    : specifier.replace(/^crate::/, '').replace(/^self::/, './').replace(/^super::/, '../');
  const cleaned = normalizedSpecifier.trim()
    .replace(/[?#].*$/, '')
    .replace(/::/g, '/')
    .replace(/\\/g, '/')
    .replace(/^@\//, '')
    .replace(/^~\//, '')
    .replace(/(?:\/\*|\.\*)$/, '');
  const relative = specifier.startsWith('.')
    || specifier.startsWith('self::')
    || specifier.startsWith('super::');
  const base = relative
    ? posix.normalize(posix.join(posix.dirname(fromFile), cleaned.replace(/^super::/, '../')))
    : cleaned.replace(/^\/+/, '').replace(/\./g, '/');
  const bases = [...new Set([base, ...configuredBases(context), ...workspaceBases(context)])];
  if (/\.rs$/i.test(fromFile)) {
    let parent = posix.dirname(base);
    while (parent !== '.') {
      bases.push(parent);
      parent = posix.dirname(parent);
    }
  }
  const possibilities = bases.flatMap((candidate) => {
    const withoutRuntimeExtension = /\.(?:mjs|cjs|js|jsx)$/i.test(candidate)
      ? candidate.replace(/\.(?:mjs|cjs|js|jsx)$/i, '')
      : candidate;
    return [...new Set([candidate, withoutRuntimeExtension])].flatMap(path => [
      path,
      ...RESOLVABLE_EXTENSIONS.map(extension => `${path}${extension}`),
      ...RESOLVABLE_EXTENSIONS.map(extension => `${path}/index${extension}`),
      `${path}/__init__.py`,
    ]);
  });
  const exact = possibilities.flatMap(path => changedPathAliases.get(path) ?? []);
  if (exact.length > 0) return [...new Set(exact)];

  const suffixes = possibilities.map(path => `/${path}`);
  const suffixMatches = [...changedPathAliases.entries()]
    .filter(([path]) => suffixes.some(suffix => `/${path}`.endsWith(suffix))
      || (/\.go$/i.test(fromFile) && bases.some(candidate =>
        `/${posix.dirname(path)}`.endsWith(`/${candidate}`) && /\.go$/i.test(path)))
      || (/\.(?:java|kt|kts)$/i.test(fromFile) && specifier.endsWith('.*')
        && bases.some(candidate => `/${posix.dirname(path)}`.endsWith(`/${candidate}`))
        && /\.(?:java|kt|kts)$/i.test(path))
      || (/\.cs$/i.test(fromFile)
        && bases.some(candidate => `/${posix.dirname(path)}`.endsWith(`/${candidate}`))
        && /\.cs$/i.test(path)))
    .map(([, currentPath]) => currentPath);
  return [...new Set(suffixMatches)];
}

function pythonImportedModules(content: string): string[] {
  return [...content.matchAll(/^\s*from\s+(\.+)\s+import\s+([^#\r\n]+)/gm)]
    .flatMap(match => match[2]
      .replace(/[()]/g, '')
      .split(',')
      .map(name => name.trim().split(/\s+as\s+/, 1)[0])
      .filter(name => /^[A-Za-z_]\w*$/.test(name))
      .map(name => `${match[1]}${name}`));
}

function referencedSpecifiers(filename: string, content: string): string[] {
  const adapter = SPECIFIER_ADAPTERS.find(candidate => candidate.supports.test(filename));
  if (!adapter) return [];
  return [...new Set([
    ...(/\.py$/i.test(filename) ? pythonImportedModules(content) : []),
    ...adapter.patterns.flatMap(pattern => [...content.matchAll(pattern)].map(match => match[1])),
  ])];
}

function isNonRelativeJavaScriptSpecifier(filename: string, specifier: string): boolean {
  return /\.(?:[cm]?[jt]sx?|vue|svelte)$/i.test(filename)
    && !specifier.startsWith('.')
    && !specifier.startsWith('/');
}

const BEST_EFFORT_LANGUAGE = /\.(?:go|rs|rb|php|java|kt|kts|cs|cpp|cc|cxx|c|h|hpp|swift|scala)$/i;

function hasDynamicJavaScriptDependency(filename: string, content: string): boolean {
  return /\.(?:[cm]?[jt]sx?|vue|svelte)$/i.test(filename)
    && /\b(?:import|require)\s*\(\s*[^'"\s)]/.test(content);
}

/** Resolve supported language imports to changed paths on both sides of the PR. */
export function addLanguageImportDependencies(
  snapshot: PrSnapshot,
  addCompanions: (left: string, right: string) => void,
): LanguageDependencyAnalysis {
  const changedPathAliases = new Map<string, string>();
  for (const file of snapshot.changedFiles) {
    changedPathAliases.set(file.filename, file.filename);
    if (file.previousFilename) changedPathAliases.set(file.previousFilename, file.filename);
  }
  const versionContexts = new Map<RepositoryVersion, {
    importAliases: ImportAliasRule[];
    packages: WorkspacePackage[];
  }>();
  const incompleteReasons: string[] = [];
  for (const version of ['base', 'head'] as const) {
    const files = repositoryAnalysisFiles(snapshot, version);
    const aliases = configuredImportAliases(files);
    const workspaces = workspacePackages(files);
    incompleteReasons.push(
      ...aliases.errors.map(reason => `${version} ${reason}`),
      ...workspaces.errors.map(reason => `${version} ${reason}`),
    );
    versionContexts.set(version, {
      importAliases: aliases.rules,
      packages: workspaces.packages,
    });
  }
  const filesRequiringCompleteConfigDiscovery = new Set<string>();
  const bestEffortFiles = new Set<string>();
  for (const file of snapshot.changedFiles) {
    const versions = [
      { name: 'head' as const, path: file.filename, content: file.headContent },
      { name: 'base' as const, path: file.previousFilename ?? file.filename, content: file.baseContent },
    ];
    if (BEST_EFFORT_LANGUAGE.test(file.filename)
      || versions.some(version => version.content !== null
        && hasDynamicJavaScriptDependency(version.path, version.content))) {
      bestEffortFiles.add(file.filename);
    }
    for (const version of versions) {
      if (version.content === null) continue;
      const specifiers = referencedSpecifiers(version.path, version.content);
      if (specifiers.some(specifier => isNonRelativeJavaScriptSpecifier(version.path, specifier))) {
        filesRequiringCompleteConfigDiscovery.add(file.filename);
      }
      const context = versionContexts.get(version.name);
      if (!context) continue;
      for (const specifier of specifiers) {
        const dependencies = resolveChangedImport({
          fromFile: version.path,
          specifier,
          changedPathAliases,
          importAliases: context.importAliases,
          packages: context.packages,
        });
        for (const dependency of dependencies) addCompanions(file.filename, dependency);
      }
    }
  }
  return {
    incompleteReasons: [...new Set(incompleteReasons)].sort(),
    filesRequiringCompleteConfigDiscovery,
    bestEffortFiles,
  };
}
