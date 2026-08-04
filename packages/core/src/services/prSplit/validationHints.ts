import type {
  PrSnapshot,
  PrSnapshotFile,
  ValidationHint,
  ValidationHintSource,
  ValidationPlan,
} from './types.js';

const VALIDATION_WORDS = /(?:^|[\s:-])(test|lint|build|check|typecheck|verify|pytest|rspec)(?:[\s:]|$)/i;
const TEST_PATH = /(^|\/)(tests?|spec|__tests__)(\/|$)|\.(test|spec)\.[^.]+$|_test\.[^.]+$/i;

function selectedSnapshotFiles(snapshot: PrSnapshot, includedFiles?: readonly string[]): PrSnapshotFile[] {
  if (!includedFiles) return snapshot.changedFiles;
  const selected = new Set(includedFiles);
  return snapshot.changedFiles.filter(file => selected.has(file.filename));
}

function packageManager(snapshot: PrSnapshot): 'npm' | 'pnpm' | 'yarn' | 'bun' {
  const paths = snapshot.changedFiles.map(file => file.filename.toLowerCase());
  if (paths.some(path => path.endsWith('pnpm-lock.yaml'))) return 'pnpm';
  if (paths.some(path => path.endsWith('yarn.lock'))) return 'yarn';
  if (paths.some(path => /(^|\/)bun\.lockb?$/.test(path))) return 'bun';
  return 'npm';
}

function packageScriptCommand(manager: ReturnType<typeof packageManager>, script: string): string {
  if (manager === 'yarn') return `yarn ${script}`;
  if (manager === 'bun') return `bun run ${script}`;
  return `${manager} run ${script}`;
}

function addHint(
  hints: ValidationHint[],
  command: string,
  details: {
    reason: string;
    source: ValidationHintSource;
    relatedFiles: string[];
  },
): void {
  const normalized = command.trim();
  if (!normalized || hints.some(hint => hint.command === normalized)) return;
  hints.push({
    command: normalized,
    reason: details.reason,
    source: details.source,
    relatedFiles: [...new Set(details.relatedFiles)].sort(),
  });
}

function workflowCommands(files: PrSnapshotFile[], hints: ValidationHint[]): void {
  for (const file of files) {
    if (!/(^|\/)\.github\/workflows\/.*\.ya?ml$/i.test(file.filename) || !file.patch) continue;
    for (const line of file.patch.split(/\r?\n/)) {
      const match = line.match(/^\s*[+ ]\s*(?:-\s*)?run:\s*(.+?)\s*$/i);
      if (!match || !VALIDATION_WORDS.test(match[1]) || match[1].includes('${{ secrets.')) continue;
      addHint(
        hints,
        match[1].replace(/^['"]|['"]$/g, ''),
        {
          reason: `Validation command used by ${file.filename}`,
          source: 'workflow',
          relatedFiles: [file.filename],
        },
      );
    }
  }
}

function changedPackageScripts(
  files: PrSnapshotFile[],
  manager: ReturnType<typeof packageManager>,
  hints: ValidationHint[],
): void {
  const supportedScripts = new Set(['test', 'lint', 'build', 'check', 'typecheck', 'verify']);
  for (const file of files) {
    if (!/(^|\/)package\.json$/i.test(file.filename) || !file.patch) continue;
    for (const line of file.patch.split(/\r?\n/)) {
      const match = line.match(/^\s*[+ ]\s*"([^"]+)"\s*:/);
      if (!match || !supportedScripts.has(match[1].toLowerCase())) continue;
      const script = match[1].toLowerCase();
      addHint(
        hints,
        packageScriptCommand(manager, script),
        {
          reason: `Script declared in ${file.filename}`,
          source: 'package-script',
          relatedFiles: [file.filename],
        },
      );
    }
  }
}

function javascriptHints(
  snapshot: PrSnapshot,
  files: PrSnapshotFile[],
  hints: ValidationHint[],
): void {
  const javascriptFiles = files.filter(file => /\.[cm]?[jt]sx?$/i.test(file.filename));
  if (javascriptFiles.length === 0) return;
  const manager = packageManager(snapshot);
  const paths = javascriptFiles.map(file => file.filename);
  if (javascriptFiles.some(file => TEST_PATH.test(file.filename))) {
    addHint(
      hints,
      manager === 'npm' ? 'npm test' : `${manager} test`,
      {
        reason: 'JavaScript/TypeScript test files are included in the split',
        source: 'language-convention',
        relatedFiles: paths.filter(path => TEST_PATH.test(path)),
      },
    );
  }
  if (javascriptFiles.some(file => /\.[cm]?tsx?$/i.test(file.filename))) {
    addHint(
      hints,
      packageScriptCommand(manager, 'typecheck'),
      {
        reason: 'TypeScript source is included in the split',
        source: 'language-convention',
        relatedFiles: paths.filter(path => /\.[cm]?tsx?$/i.test(path)),
      },
    );
  }
  if (!hints.some(hint => /\b(test|typecheck|build|lint)\b/i.test(hint.command))) {
    addHint(
      hints,
      manager === 'npm' ? 'npm test' : `${manager} test`,
      {
        reason: 'JavaScript source should be covered by the repository test suite',
        source: 'language-convention',
        relatedFiles: paths,
      },
    );
  }
}

function languageHints(files: PrSnapshotFile[], hints: ValidationHint[]): void {
  const paths = files.map(file => file.filename);
  const addForExtensions = (
    expression: RegExp,
    command: string,
    reason: string,
  ): void => {
    const related = paths.filter(path => expression.test(path));
    if (related.length > 0) {
      addHint(hints, command, { reason, source: 'language-convention', relatedFiles: related });
    }
  };

  addForExtensions(/\.go$/i, 'go test ./...', 'Go source is included in the split');
  addForExtensions(/\.rs$/i, 'cargo test', 'Rust source is included in the split');
  addForExtensions(
    /\.py$/i,
    paths.some(path => TEST_PATH.test(path)) ? 'python -m pytest' : 'python -m compileall .',
    'Python source is included in the split',
  );
  addForExtensions(
    /(^|\/)spec\/.*\.rb$|_spec\.rb$/i,
    'bundle exec rspec',
    'Ruby specs are included in the split',
  );
  addForExtensions(/\.php$/i, 'composer test', 'PHP source is included in the split');

  if (paths.some(path => /(^|\/)pom\.xml$/i.test(path))) {
    addHint(hints, 'mvn test', {
      reason: 'Maven project convention detected',
      source: 'repository-convention',
      relatedFiles: paths,
    });
  } else if (paths.some(path => /(^|\/)gradlew$|\.gradle(?:\.kts)?$/i.test(path))) {
    addHint(hints, './gradlew test', {
      reason: 'Gradle project convention detected',
      source: 'repository-convention',
      relatedFiles: paths,
    });
  }
  if (paths.some(path => /(^|\/)Makefile$/i.test(path))) {
    const makefile = files.find(file => /(^|\/)Makefile$/i.test(file.filename));
    if (makefile?.patch && /^\s*[+ ]\s*test\s*:/m.test(makefile.patch)) {
      addHint(hints, 'make test', {
        reason: 'Makefile test target detected',
        source: 'repository-convention',
        relatedFiles: [makefile.filename],
      });
    }
  }
}

/** Infer validation commands without reading or executing untrusted repository code. */
export function inferValidationHints(
  snapshot: PrSnapshot,
  includedFiles?: readonly string[],
): ValidationPlan {
  const files = selectedSnapshotFiles(snapshot, includedFiles);
  const hints: ValidationHint[] = [];
  workflowCommands(files, hints);
  changedPackageScripts(files, packageManager(snapshot), hints);
  javascriptHints(snapshot, files, hints);
  languageHints(files, hints);

  if (hints.length === 0) {
    return {
      commands: [],
      hints: [],
      inferred: false,
      explanation: 'No validation command could be inferred from the selected files or repository conventions; manual validation is required.',
    };
  }
  return {
    commands: hints.map(hint => hint.command),
    hints,
    inferred: true,
    explanation: `${hints.length} validation command${hints.length === 1 ? '' : 's'} inferred from the selected files and repository conventions.`,
  };
}

export const detectValidationHints = inferValidationHints;
