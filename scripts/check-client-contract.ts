#!/usr/bin/env tsx
/**
 * Fails when `@propr/client` drifts from the published dashboard API spec.
 *
 * - Every entry of `PROPR_API_OPERATIONS` must be a documented operation of
 *   docs/static/openapi/propr-api.yaml with the same method and path, and the
 *   generated types it names must be the ones the spec uses.
 * - The `ProprClient` method of each typed operation must exist and accept and
 *   return exactly those generated types. A method may instead build the body
 *   in a local declared with the generated type, and take a path parameter as a
 *   field of an argument.
 * - No client source outside the operations table may spell an `/api/` path or
 *   an HTTP method, so every request is sent with the method checked above.
 *   packages/client/test/apiOperations.test.ts checks that each operation's
 *   request really goes out with that method and path.
 *
 * Request and response types themselves are generated from the same schemas by
 * `npm run gen:openapi`; `gen:openapi:check` keeps them fresh.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import YAML from 'yaml';
import { PROPR_API_OPERATIONS, type ProprApiOperation } from '../packages/client/src/operations.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = 'docs/static/openapi/propr-api.yaml';
const CLIENT_SRC = 'packages/client/src';
const TYPES_NAMESPACE = 'ProprApi';

type Json = Record<string, unknown>;
interface SpecOperation { method: string; path: string; operation: Json }

function refName(value: unknown): string | undefined {
  const ref = (value as Json | undefined)?.$ref;
  return typeof ref === 'string' ? ref.split('/').pop() : undefined;
}

function specOperations(spec: Json): Map<string, SpecOperation> {
  const operations = new Map<string, SpecOperation>();
  for (const [specPath, methods] of Object.entries(spec.paths as Record<string, Record<string, Json>>)) {
    for (const [method, operation] of Object.entries(methods)) {
      operations.set(operation.operationId as string, { method: method.toUpperCase(), path: specPath, operation });
    }
  }
  return operations;
}

function checkAgainstSpec(id: string, entry: ProprApiOperation, found: SpecOperation | undefined, typeNames: Set<string>): string[] {
  if (!found) return [`${id}: no operation with this operationId in ${SPEC}`];
  const errors: string[] = [];
  const { operation } = found;
  if (found.method !== entry.method || found.path !== entry.path) {
    errors.push(`${id}: client calls ${entry.method} ${entry.path}, spec defines ${found.method} ${found.path}`);
  }
  if (operation['x-undocumented']) errors.push(`${id}: the client depends on an x-undocumented operation; document it in packages/api/openapi`);
  const query = ((operation.parameters ?? []) as Json[]).filter(parameter => parameter.in === 'query');
  const expectedQuery = query.length ? operation['x-propr-query-type'] as string | undefined : undefined;
  if (entry.query !== expectedQuery) errors.push(`${id}: query type is ${entry.query ?? 'none'}, spec implies ${expectedQuery ?? 'none'}`);
  const jsonBody = ((operation.requestBody as Json | undefined)?.content as Json | undefined)?.['application/json'] as Json | undefined;
  const body = refName(jsonBody?.schema);
  if (entry.requestBody !== body) errors.push(`${id}: request body type is ${entry.requestBody ?? 'none'}, spec uses ${body ?? 'none'}`);
  if (entry.response) {
    const successes = Object.entries(operation.responses as Record<string, Json>)
      .filter(([status, response]) => /^2\d\d$/.test(status) && response.content);
    const names = successes.map(([, response]) => refName(((response.content as Json)['application/json'] as Json | undefined)?.schema));
    if (!names.length || names.some(name => name !== entry.response)) {
      errors.push(`${id}: response type is ${entry.response}, spec success responses use ${names.join(', ') || 'none'}`);
    }
  }
  for (const name of [entry.query, entry.requestBody, entry.response]) {
    if (name && !typeNames.has(name)) errors.push(`${id}: ${CLIENT_SRC}/generated/apiTypes.ts does not export ${name}; run npm run gen:openapi`);
  }
  return errors;
}

function clientMethods(source: ts.SourceFile): Map<string, ts.MethodDeclaration> {
  const methods = new Map<string, ts.MethodDeclaration>();
  source.forEachChild(node => {
    if (!ts.isClassDeclaration(node) || node.name?.text !== 'ProprClient') return;
    for (const member of node.members) {
      if (ts.isMethodDeclaration(member) && ts.isIdentifier(member.name)) methods.set(member.name.text, member);
    }
  });
  return methods;
}

function checkSignature(id: string, entry: ProprApiOperation, method: ts.MethodDeclaration | undefined, source: ts.SourceFile): string[] {
  if (!entry.clientMethod) return [];
  if (!method) return [`${id}: ProprClient has no ${entry.clientMethod}() method`];
  if (!entry.response) return [];
  const errors: string[] = [];
  const text = (node: ts.Node | undefined) => node?.getText(source).replace(/\s+/g, '') ?? '';
  const parameterTypes = method.parameters.map(parameter => text(parameter.type));
  const expectedReturn = `Promise<${TYPES_NAMESPACE}.${entry.response}>`;
  if (text(method.type) !== expectedReturn) errors.push(`${id}: ${entry.clientMethod}() must return ${expectedReturn}, found ${text(method.type) || 'no annotation'}`);
  if (entry.query && !parameterTypes.includes(`${TYPES_NAMESPACE}.${entry.query}`)) {
    errors.push(`${id}: ${entry.clientMethod}() must accept ${TYPES_NAMESPACE}.${entry.query}`);
  }
  // A method may also assemble the body from its arguments into a typed local.
  const bodyType = `${TYPES_NAMESPACE}.${entry.requestBody}`;
  if (entry.requestBody && !parameterTypes.includes(bodyType) && !text(method.body).includes(`:${bodyType}=`)) {
    errors.push(`${id}: ${entry.clientMethod}() must accept ${bodyType}, or build the body in a local declared as ${bodyType}`);
  }
  const parameterNames = method.parameters.map(parameter => text(parameter.name));
  for (const [, name] of entry.path.matchAll(/\{([^}]+)\}/g)) {
    // Either its own argument, or a field of one (`pairing.pairingId`).
    const fromArgument = parameterNames.some(parameter => text(method.body).includes(`{${name}:${parameter}.${name}}`));
    if (!parameterNames.includes(name) && !fromArgument) {
      errors.push(`${id}: ${entry.clientMethod}() must take the ${name} path parameter, or a value carrying it`);
    }
  }
  return errors;
}

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(path.join(root, directory), { withFileTypes: true });
  const files = await Promise.all(entries.map(entry => entry.isDirectory()
    ? sourceFiles(path.join(directory, entry.name))
    : Promise.resolve(entry.name.endsWith('.ts') ? [path.join(directory, entry.name)] : [])));
  return files.flat();
}

async function hardCodedRequests(): Promise<string[]> {
  const errors: string[] = [];
  for (const file of await sourceFiles(CLIENT_SRC)) {
    if (file.endsWith('operations.ts') || file.includes(`${path.sep}generated${path.sep}`)) continue;
    const contents = await readFile(path.join(root, file), 'utf8');
    contents.split('\n').forEach((line, index) => {
      if (/['"`]\/api\//.test(line)) errors.push(`${file}:${index + 1}: build API paths with operationPath() from operations.ts`);
      if (/\bmethod\s*:\s*['"`]/.test(line)) errors.push(`${file}:${index + 1}: take the HTTP method from operationMethod() in operations.ts`);
    });
  }
  return errors;
}

async function main(): Promise<number> {
  const spec = YAML.parse(await readFile(path.join(root, SPEC), 'utf8')) as Json;
  const operations = specOperations(spec);
  const typesFile = path.join(root, CLIENT_SRC, 'generated/apiTypes.ts');
  const types = ts.createSourceFile(typesFile, await readFile(typesFile, 'utf8'), ts.ScriptTarget.Latest, true);
  const typeNames = new Set<string>();
  types.forEachChild(node => {
    if ((ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node))) typeNames.add(node.name.text);
  });
  const clientFile = path.join(root, CLIENT_SRC, 'client.ts');
  const client = ts.createSourceFile(clientFile, await readFile(clientFile, 'utf8'), ts.ScriptTarget.Latest, true);
  const methods = clientMethods(client);

  const errors: string[] = [];
  for (const [id, entry] of Object.entries(PROPR_API_OPERATIONS) as [string, ProprApiOperation][]) {
    errors.push(...checkAgainstSpec(id, entry, operations.get(id), typeNames));
    errors.push(...checkSignature(id, entry, entry.clientMethod ? methods.get(entry.clientMethod) : undefined, client));
  }
  errors.push(...await hardCodedRequests());

  if (errors.length) {
    console.error('@propr/client does not match the dashboard API spec:');
    for (const error of errors) console.error(`  - ${error}`);
    return 1;
  }
  console.log(`@propr/client matches ${SPEC} (${Object.keys(PROPR_API_OPERATIONS).length} operations).`);
  return 0;
}

main().then(code => process.exit(code), error => { console.error(error); process.exit(1); });
