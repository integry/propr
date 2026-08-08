import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import { isValidDockerContainerReference } from '../routes/dockerCommandSafety.js';

const SHELL_EXECUTION_APIS = new Set(['exec', 'execSync']);

function propertyNameText(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) {
    return name.text;
  }
  if (ts.isComputedPropertyName(name) && ts.isStringLiteral(name.expression)) {
    return name.expression.text;
  }
  return undefined;
}

function isShellPropertyAccess(node: ts.Node): boolean {
  return (ts.isPropertyAccessExpression(node) && node.name.text === 'shell')
    || (ts.isElementAccessExpression(node)
      && ts.isStringLiteral(node.argumentExpression)
      && node.argumentExpression.text === 'shell');
}

function findShellExecution(source: string, relativePath: string): string[] {
  const sourceFile = ts.createSourceFile(relativePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const violations: string[] = [];

  function report(node: ts.Node, reason: string): void {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    violations.push(`${relativePath}:${line + 1}:${character + 1} ${reason}`);
  }

  function visit(node: ts.Node): void {
    if (ts.isIdentifier(node) && SHELL_EXECUTION_APIS.has(node.text)) {
      report(node, `uses shell-executing child_process API ${node.text}`);
    } else if (ts.isElementAccessExpression(node)
      && ts.isStringLiteral(node.argumentExpression)
      && SHELL_EXECUTION_APIS.has(node.argumentExpression.text)) {
      report(node, `uses shell-executing child_process API ${node.argumentExpression.text}`);
    } else if (ts.isPropertyAssignment(node)
      && propertyNameText(node.name) === 'shell'
      && node.initializer.kind !== ts.SyntaxKind.FalseKeyword) {
      report(node, 'enables a child_process shell option');
    } else if (ts.isShorthandPropertyAssignment(node) && node.name.text === 'shell') {
      report(node, 'passes a potentially enabled child_process shell option');
    } else if (ts.isBinaryExpression(node)
      && isShellPropertyAccess(node.left)
      && (node.operatorToken.kind !== ts.SyntaxKind.EqualsToken
        || node.right.kind !== ts.SyntaxKind.FalseKeyword)) {
      report(node, 'enables a child_process shell option');
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return violations;
}

test('accepts Docker IDs and ProPR-generated container names', () => {
  assert.equal(isValidDockerContainerReference('18f3ec9e3ae1'), true);
  assert.equal(isValidDockerContainerReference('propr-agent-owner-repo-42'), true);
  assert.equal(isValidDockerContainerReference('worker_1.2'), true);
});

test('rejects container references that could be parsed as options or shell syntax', () => {
  for (const value of ['--help', 'name with spaces', 'name;id', '$(id)', 'name/child', '']) {
    assert.equal(isValidDockerContainerReference(value), false, value);
  }
});

test('production subprocess call sites do not invoke a command shell', () => {
  const productionFiles = [
    '../routes/dockerCommandSafety.ts',
    '../routes/dockerRoutes.ts',
    '../../core/src/claude/docker/dockerExecutor.ts',
    '../../core/src/git/worktreeOperations.ts',
    '../../core/src/agents/impl/CodexAgent.ts',
    '../../core/src/agents/impl/OpenCodeAgent.ts',
    '../../cli/src/auth/githubLogin.ts',
  ];

  for (const relativePath of productionFiles) {
    const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8');
    assert.deepEqual(findShellExecution(source, relativePath), []);
  }
});

test('no-shell guard rejects aliases and enabled shell options', () => {
  const unsafeSources = [
    "import { exec } from 'node:child_process'; exec('docker ps');",
    "import { execSync as run } from 'child_process'; run('docker ps');",
    "import * as childProcess from 'node:child_process'; childProcess['execSync']('docker ps');",
    "import { execFileSync } from 'child_process'; execFileSync('docker', ['ps'], { shell: true });",
    "import { spawn } from 'child_process'; const options = { shell: '/bin/sh' }; spawn('docker', ['ps'], options);",
    "import { spawnSync } from 'child_process'; const options = {}; options.shell = true; spawnSync('docker', ['ps'], options);",
  ];

  for (const source of unsafeSources) {
    assert.notDeepEqual(findShellExecution(source, 'fixture.ts'), [], source);
  }

  const safeSource = "import { execFileSync, spawn } from 'child_process'; execFileSync('docker', ['ps'], { shell: false }); spawn('docker', ['ps']);";
  assert.deepEqual(findShellExecution(safeSource, 'fixture.ts'), []);
});
