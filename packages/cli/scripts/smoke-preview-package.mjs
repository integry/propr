import assert from 'node:assert/strict';
import ts from 'typescript';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sha256File } from '../../../scripts/preview-runtime-images.mjs';

export async function smokePreviewPackage(tarball, expected) {
  const prefix = mkdtempSync(join(tmpdir(), 'propr-cli-preview-smoke-'));
  const run = (command, args) => execFileSync(command, args, {
    cwd: prefix, encoding: 'utf8', env: { ...process.env, HOME: prefix, XDG_CONFIG_HOME: join(prefix, 'config'),
      npm_config_userconfig: join(prefix, 'empty-npmrc') },
  }).trim();
  try {
    run('npm', ['install', '--global', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', resolve(tarball)]);
    const installed = join(prefix, 'lib/node_modules/propr-cli');
    const pkg = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'));
    assert.equal(pkg.version, expected.version);
    for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      assert.ok(!Object.keys(pkg[section] || {}).some(name => name.startsWith('@propr/')), 'Private workspace dependency survived');
    }
    const scan = directory => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) scan(path);
        else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) {
          const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
          const inspect = node => {
            const specifier = (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) ? node.moduleSpecifier
              : ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
                || (ts.isIdentifier(node.expression) && node.expression.text === 'require')) ? node.arguments[0] : undefined;
            if (specifier && ts.isStringLiteralLike(specifier)) {
              assert.ok(!specifier.text.startsWith('@propr/'), `Private import in ${path}: ${specifier.text}`);
            }
            ts.forEachChild(node, inspect);
          };
          inspect(source);
        }
      }
    };
    scan(join(installed, 'dist'));
    const executable = join(prefix, 'bin/propr');
    assert.equal(run(executable, ['--version']), expected.version);
    assert.match(run(executable, ['--help']), /Usage: propr/);
    const manifestPath = join(installed, 'dist/orchestrator/manifest.json');
    assert.deepEqual(JSON.parse(readFileSync(manifestPath, 'utf8')), expected.manifest);
    const orchestrator = await import(pathToFileURL(join(installed, 'dist/orchestrator/orchestrator.mjs')).href);
    // Exercise the installed launcher's default manifest lookup, without Docker,
    // an override manifest path, provider credentials, or starting any service.
    const config = orchestrator.resolveHostConfig({ rootDir: prefix, env: {} });
    assert.deepEqual(config.images, expected.manifest.images);
    assert.equal(config.manifest.git_sha, expected.manifest.git_sha);
    return { cleanPrefixInstall: true, version: true, help: true, noPrivateWorkspaceDependencies: true,
      bundledRuntimeSelection: true, manifestSha256: sha256File(manifestPath) };
  } finally {
    rmSync(prefix, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [tarball, manifestPath] = process.argv.slice(2);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  console.log(JSON.stringify(await smokePreviewPackage(tarball, { version: manifest.version, manifest }), null, 2));
}
