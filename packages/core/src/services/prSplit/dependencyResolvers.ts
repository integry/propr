import { posix } from 'node:path';
import type { PrSnapshot } from './types.js';

interface ImportAliasRule {
  matchPrefix: string;
  matchSuffix: string;
  targetPrefix: string;
  targetSuffix: string;
  wildcard: boolean;
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
    patterns: [/\b(?:require_relative|load)\s*\(?\s*['"]([^'"]+)['"]/g],
  },
  {
    supports: /\.php$/i,
    patterns: [/\b(?:include|include_once|require|require_once)\s*\(?\s*['"]([^'"]+)['"]/g, /^\s*use\s+([\\\w]+)/gm],
  },
  {
    supports: /\.(?:java|kt|kts|cs|swift|scala)$/i,
    patterns: [/^\s*import\s+([\w.*]+)/gm],
  },
  {
    supports: /\.(?:c|cc|cpp|cxx|h|hpp)$/i,
    patterns: [/^\s*#\s*include\s*"([^"]+)"/gm],
  },
];

function repositoryAnalysisFiles(snapshot: PrSnapshot): Array<{
  path: string;
  content: string | null;
  contentComplete: boolean;
}> {
  const files = new Map(snapshot.repositoryFiles.map(file => [file.path, file]));
  for (const changed of snapshot.changedFiles) {
    if (changed.status === 'removed' || changed.headContent === null) continue;
    files.set(changed.filename, {
      path: changed.filename,
      content: changed.headContent,
      contentComplete: changed.contentComplete,
    });
  }
  const analysisFiles = [...files.values()];
  for (const changed of snapshot.changedFiles) {
    if (changed.baseContent === null
      || !/(^|\/)(?:package\.json|tsconfig(?:\.[^/]+)?\.json|jsconfig\.json)$/i.test(changed.filename)) continue;
    analysisFiles.push({
      path: changed.previousFilename ?? changed.filename,
      content: changed.baseContent,
      contentComplete: changed.contentComplete,
    });
  }
  return analysisFiles;
}

function configuredImportAliases(snapshot: PrSnapshot): ImportAliasRule[] {
  return repositoryAnalysisFiles(snapshot).flatMap((file) => {
    if (!/(^|\/)(?:tsconfig(?:\.[^/]+)?|jsconfig)\.json$/i.test(file.path)
      || !file.contentComplete
      || !file.content) return [];
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
            targetPrefix: targetWildcard >= 0
              ? resolvedTarget.slice(0, resolvedTarget.indexOf('*'))
              : resolvedTarget,
            targetSuffix: targetWildcard >= 0
              ? resolvedTarget.slice(resolvedTarget.indexOf('*') + 1)
              : '',
            wildcard: wildcard >= 0,
          }];
        });
      });
    } catch {
      return [];
    }
  });
}

function packageTargets(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(packageTargets);
  if (typeof value !== 'object' || value === null) return [];
  return Object.values(value).flatMap(packageTargets);
}

function workspacePackages(snapshot: PrSnapshot): WorkspacePackage[] {
  return repositoryAnalysisFiles(snapshot).flatMap((file) => {
    if (posix.basename(file.path) !== 'package.json' || !file.contentComplete || !file.content) return [];
    try {
      const parsed = JSON.parse(file.content) as Record<string, unknown>;
      if (typeof parsed.name !== 'string' || !parsed.name.trim()) return [];
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
      return [{ name: parsed.name.trim(), directory, entrypoints }];
    } catch {
      return [];
    }
  });
}

function configuredBases(context: ImportResolutionContext): string[] {
  return context.importAliases.flatMap((rule) => {
    if (!rule.wildcard) return context.specifier === rule.matchPrefix ? [rule.targetPrefix] : [];
    if (!context.specifier.startsWith(rule.matchPrefix)
      || !context.specifier.endsWith(rule.matchSuffix)) return [];
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
    .replace(/\/\*$/, '');
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
        `/${posix.dirname(path)}`.endsWith(`/${candidate}`) && /\.go$/i.test(path))))
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

/** Resolve supported language imports to changed paths on both sides of the PR. */
export function addLanguageImportDependencies(
  snapshot: PrSnapshot,
  addCompanions: (left: string, right: string) => void,
): void {
  const changedPathAliases = new Map<string, string>();
  for (const file of snapshot.changedFiles) {
    changedPathAliases.set(file.filename, file.filename);
    if (file.previousFilename) changedPathAliases.set(file.previousFilename, file.filename);
  }
  const importAliases = configuredImportAliases(snapshot);
  const packages = workspacePackages(snapshot);
  for (const file of snapshot.changedFiles) {
    const versions = [
      { path: file.filename, content: file.headContent },
      { path: file.previousFilename ?? file.filename, content: file.baseContent },
    ];
    for (const version of versions) {
      if (version.content === null) continue;
      for (const specifier of referencedSpecifiers(version.path, version.content)) {
        const dependencies = resolveChangedImport({
          fromFile: version.path,
          specifier,
          changedPathAliases,
          importAliases,
          packages,
        });
        for (const dependency of dependencies) addCompanions(file.filename, dependency);
      }
    }
  }
}
