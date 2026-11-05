import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';

// The app image builder compiles from a filtered context: only its COPY inputs
// exist, plus the dist output of workspaces it built earlier. A full checkout
// hides any import that reaches outside those inputs, so ask the compiler for
// each builder project's real source closure and check it against the context.

const repoRoot = fs.realpathSync(path.resolve(import.meta.dirname, '..'));
const dockerfile = fs.readFileSync(path.join(repoRoot, 'docker/Dockerfile.app.prod'), 'utf8');
const builder = dockerfile.slice(0, dockerfile.indexOf(' AS runtime'));

function instructions(stage) {
  return stage.replace(/\\\n/g, ' ').split('\n').map((line) => line.trim()).filter(Boolean);
}

function builderCopySources() {
  return instructions(builder).flatMap((line) => {
    const match = line.match(/^COPY\s+(?!--)(.+)$/);
    if (!match) return [];
    const args = match[1].trim().split(/\s+/);
    return args.slice(0, -1).map((source) => path.resolve(repoRoot, source));
  });
}

// `RUN cd a && npm run build && cd ../b && npm run build ...` in build order.
function builderTscProjects() {
  const projects = [];
  for (const line of instructions(builder)) {
    if (!line.startsWith('RUN ') || !line.includes('npm run build')) continue;
    let cwd = repoRoot;
    for (const step of line.slice(4).split('&&').map((part) => part.trim())) {
      const cd = step.match(/^cd\s+(\S+)$/);
      if (cd) cwd = path.resolve(cwd, cd[1]);
      else if (step === 'npm run build') projects.push(cwd);
    }
  }
  return projects;
}

function compilerInputs(project) {
  const config = ts.getParsedCommandLineOfConfigFile(path.join(project, 'tsconfig.json'), {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
      throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
    },
  });
  const program = ts.createProgram({ rootNames: config.fileNames, options: config.options });
  return program.getSourceFiles()
    .filter((file) => !program.isSourceFileDefaultLibrary(file))
    .map((file) => fs.realpathSync(file.fileName))
    .filter((file) => file.startsWith(`${repoRoot}${path.sep}`) && !file.split(path.sep).includes('node_modules'));
}

const within = (file, roots) => roots.some((root) => file === root || file.startsWith(`${root}${path.sep}`));

test('app builder compiles the root project after its workspaces', () => {
  assert.deepEqual(builderTscProjects().map((project) => path.relative(repoRoot, project) || '.'), [
    'packages/shared',
    'packages/local-setup',
    'packages/core',
    '.',
  ]);
});

test('every source the app builder compiles is inside its Docker inputs', () => {
  const copied = builderCopySources();
  const built = [];
  const missing = new Set();
  let checked = 0;
  for (const project of builderTscProjects()) {
    for (const file of compilerInputs(project)) {
      checked += 1;
      if (!within(file, [...copied, ...built])) missing.add(path.relative(repoRoot, file));
    }
    if (project !== repoRoot) built.push(path.join(project, 'dist'));
  }
  assert.ok(checked > 100, 'compiler closure should cover the app sources');
  assert.deepEqual([...missing].sort(), [], 'compiled by the app builder but absent from its COPY inputs');
});
