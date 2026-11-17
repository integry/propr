import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { buildPluginContract, type PluginContract } from '../../src/pluginContract.js';

/**
 * The plugin interface as the TypeScript sources declare it, read with the
 * compiler, so the contract is checked against the real interfaces rather
 * than against its own description of them.
 *
 * - Event payloads and the event envelope: each field's type reduced to a
 *   contract descriptor (`string`, `number | null`, `string[]`, …), to compare
 *   with `PLUGIN_EVENT_PAYLOAD_FIELDS` and `PLUGIN_EVENT_ENVELOPE_FIELDS`.
 * - The handler SDK: the declared type of every member of `PluginContext`,
 *   the input envelopes and every shared interface or type alias they reach
 *   (`ctx.state` and `ctx.propr` methods with their parameters and results,
 *   the summaries those return, …), recorded in the contract's `sdk.types`.
 *
 * `overrides` replaces the text of source files (absolute path → text), so a
 * test can show that changing an interface is detected.
 */

const SOURCE = fileURLToPath(new URL('../../src/', import.meta.url));
export const PLUGIN_SDK_SOURCE = `${SOURCE}pluginSdk.ts`;
export const REPOSITORY_EVENTS_SOURCE = `${SOURCE}repositoryEvents.ts`;

/** Journal events whose payload has a shared interface, and that interface (in `repositoryEvents.ts`). */
export const PLUGIN_EVENT_PAYLOAD_INTERFACES: Record<string, string> = {
  'pull_request.review_scored': 'ReviewScoredEventPayload',
  'pull_request.ultrafix_started': 'UltrafixStartedEventPayload',
  'pull_request.ultrafix_ended': 'UltrafixEndedEventPayload',
  'epic_queue.advanced': 'EpicQueueAdvancedEventPayload',
  'epic_queue.blocked': 'EpicQueueBlockedEventPayload',
  'plan_issue.status_changed': 'PlanIssueStatusChangedEventPayload',
  'task.queued': 'TaskEventPayload',
  'task.started': 'TaskEventPayload',
  'task.completed': 'TaskTerminalEventPayload',
  'task.failed': 'TaskTerminalEventPayload',
  'task.cancelled': 'TaskTerminalEventPayload',
};

/** Where the SDK walk starts: what a handler receives. */
const SDK_ROOTS = ['PluginContext', 'PluginEventInput', 'PluginWebhookInput', 'PluginCommandInput', 'PluginInvokeInput', 'PluginSettingOptionsInput'];

export interface PluginContractSource {
  payloads: Record<string, Record<string, string>>;
  envelope: Record<string, string>;
  sdkTypes: Record<string, string>;
}

const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });

function createProgram(overrides: Record<string, string>) {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, strict: true, noEmit: true, skipLibCheck: true,
  };
  const host = ts.createCompilerHost(options, true);
  const { getSourceFile, readFile, fileExists } = host;
  host.fileExists = file => file in overrides || fileExists.call(host, file);
  host.readFile = file => (file in overrides ? overrides[file] : readFile.call(host, file));
  host.getSourceFile = (file, language, onError, shouldCreate) => (file in overrides
    ? ts.createSourceFile(file, overrides[file], language, true)
    : getSourceFile.call(host, file, language, onError, shouldCreate));
  return ts.createProgram([PLUGIN_SDK_SOURCE, REPOSITORY_EVENTS_SOURCE], options, host);
}

/** A declaration's type reduced to a contract descriptor, as `PLUGIN_EVENT_PAYLOAD_FIELDS` writes it. */
function descriptor(checker: ts.TypeChecker, type: ts.Type): string {
  const parts = type.isUnion() ? type.types : [type];
  const nullable = parts.some(part => part.flags & ts.TypeFlags.Null);
  const names = [...new Set(parts.filter(part => !(part.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined))).map(part => baseDescriptor(checker, part)))].sort();
  return [...names, ...(nullable ? ['null'] : [])].join(' | ');
}

function baseDescriptor(checker: ts.TypeChecker, type: ts.Type): string {
  if (type.flags & ts.TypeFlags.StringLike) return 'string';
  if (type.flags & ts.TypeFlags.NumberLike) return 'number';
  if (type.flags & ts.TypeFlags.BooleanLike) return 'boolean';
  if (checker.isArrayType(type)) {
    const inner = descriptor(checker, checker.getTypeArguments(type as ts.TypeReference)[0]);
    return inner.includes(' | ') ? `(${inner})[]` : `${inner}[]`;
  }
  if (type.flags & ts.TypeFlags.Object) return 'object';
  return checker.typeToString(type);
}

function interfaceIn(file: ts.SourceFile, name: string): ts.InterfaceDeclaration {
  const found = file.statements.find((s): s is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(s) && s.name.text === name);
  if (!found) throw new Error(`${file.fileName} has no interface ${name}`);
  return found;
}

/** `key: descriptor` of every property of an interface, its inherited ones included; `?` marks an optional key. */
function fieldDescriptors(checker: ts.TypeChecker, declaration: ts.InterfaceDeclaration): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const property of checker.getPropertiesOfType(checker.getTypeAtLocation(declaration))) {
    const optional = (property.flags & ts.SymbolFlags.Optional) !== 0;
    fields[optional ? `${property.name}?` : property.name] = descriptor(checker, checker.getTypeOfSymbolAtLocation(property, declaration));
  }
  return fields;
}

const print = (node: ts.Node, file: ts.SourceFile) => printer.printNode(ts.EmitHint.Unspecified, node, file).replace(/\s+/g, ' ').replace(/;\s*}/g, ' }').trim();
const signatureText = (node: ts.SignatureDeclarationBase, file: ts.SourceFile) => {
  const typeParameters = node.typeParameters ? `<${node.typeParameters.map(p => print(p, file)).join(', ')}>` : '';
  return `${typeParameters}(${node.parameters.map(p => print(p, file)).join(', ')}) => ${node.type ? print(node.type, file) : 'void'}`;
};

/** The declared type text of every member of the SDK interfaces, following references into shared sources. */
function sdkTypes(program: ts.Program, checker: ts.TypeChecker, sdk: ts.SourceFile): Record<string, string> {
  const types: Record<string, string> = {};
  const seen = new Set<ts.Declaration>();
  const queue: ts.Declaration[] = SDK_ROOTS.map(name => interfaceIn(sdk, name));
  const follow = (node: ts.Node) => {
    const visit = (child: ts.Node) => {
      const name = ts.isTypeReferenceNode(child) ? child.typeName : ts.isExpressionWithTypeArguments(child) ? child.expression : undefined;
      if (name) {
        let symbol = checker.getSymbolAtLocation(name);
        if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
        for (const declaration of symbol?.declarations ?? []) {
          const inShared = declaration.getSourceFile().fileName.startsWith(SOURCE) && !program.isSourceFileDefaultLibrary(declaration.getSourceFile());
          if (inShared && (ts.isInterfaceDeclaration(declaration) || ts.isTypeAliasDeclaration(declaration)) && !seen.has(declaration)) queue.push(declaration);
        }
      }
      ts.forEachChild(child, visit);
    };
    visit(node);
  };
  while (queue.length) {
    const declaration = queue.shift()!;
    if (seen.has(declaration)) continue;
    seen.add(declaration);
    const file = declaration.getSourceFile();
    if (ts.isTypeAliasDeclaration(declaration)) {
      const name = declaration.name.text;
      let text = print(declaration.type, file);
      // An alias like `(typeof LIST)[number]` changes with LIST's values, which its text does not show.
      if (/\btypeof\b/.test(text)) text += ` = ${checker.typeToString(checker.getTypeAtLocation(declaration.type), undefined, ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.InTypeAlias)}`;
      types[name] = text;
      follow(declaration.type);
      continue;
    }
    if (!ts.isInterfaceDeclaration(declaration)) continue;
    const name = declaration.name.text;
    for (const clause of declaration.heritageClauses ?? []) {
      types[`${name} extends`] = clause.types.map(t => print(t, file)).join(', ');
      follow(clause);
    }
    for (const member of declaration.members) {
      const optional = 'questionToken' in member && member.questionToken ? '?' : '';
      if (ts.isPropertySignature(member) && member.type) types[`${name}.${member.name.getText(file)}${optional}`] = print(member.type, file);
      else if (ts.isMethodSignature(member)) types[`${name}.${member.name.getText(file)}${optional}`] = signatureText(member, file);
      else if (ts.isIndexSignatureDeclaration(member)) types[`${name}[${member.parameters.map(p => print(p, file)).join(', ')}]`] = member.type ? print(member.type, file) : 'any';
      else if (ts.isCallSignatureDeclaration(member)) types[`${name}()`] = signatureText(member, file);
      else throw new Error(`${name}: member kind ${ts.SyntaxKind[member.kind]} is not recorded in the plugin contract`);
      follow(member);
    }
  }
  return Object.fromEntries(Object.entries(types).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** Read the plugin interface from the sources (with `overrides` replacing file text). */
export function readPluginContractSource({ overrides = {} }: { overrides?: Record<string, string> } = {}): PluginContractSource {
  const program = createProgram(overrides);
  const checker = program.getTypeChecker();
  const events = program.getSourceFile(REPOSITORY_EVENTS_SOURCE)!;
  const sdk = program.getSourceFile(PLUGIN_SDK_SOURCE)!;
  const payloads = Object.fromEntries(Object.entries(PLUGIN_EVENT_PAYLOAD_INTERFACES).map(([event, name]) => [event, fieldDescriptors(checker, interfaceIn(events, name))]));
  return { payloads, envelope: fieldDescriptors(checker, interfaceIn(events, 'RepositoryEvent')), sdkTypes: sdkTypes(program, checker, sdk) };
}

/**
 * The plugin contract with what the sources declare: payload and envelope
 * types read from the interfaces (where `buildPluginContract()` has the
 * descriptors written in `pluginContract.ts`), and the SDK's declared types.
 * This is what the snapshot records and the contract test compares.
 */
export function buildSourcePluginContract(source: PluginContractSource = readPluginContractSource()): PluginContract {
  const contract = buildPluginContract();
  // In the order pluginContract.ts writes the fields (inherited fields come last from the compiler), then any it does not list.
  const ordered = (written: Record<string, string> = {}, fields: Record<string, string>) =>
    Object.fromEntries([...Object.keys(written).filter(key => key in fields), ...Object.keys(fields).filter(key => !(key in written))].map(key => [key, fields[key]]));
  for (const [event, fields] of Object.entries(source.payloads)) contract.events.payloads[event] = ordered(contract.events.payloads[event], fields);
  contract.events.envelope = ordered(contract.events.envelope, source.envelope);
  contract.sdk.types = { ...source.sdkTypes };
  return contract;
}

/** Where the descriptors written in `pluginContract.ts` (which the docs are generated from) differ from the sources. */
export function pluginContractSourceMismatches(source: PluginContractSource = readPluginContractSource()): string[] {
  const written = buildPluginContract();
  const mismatches: string[] = [];
  const compare = (what: string, declared: Record<string, string>, actual: Record<string, string>) => {
    if (JSON.stringify(declared) !== JSON.stringify(actual)) mismatches.push(`${what}: pluginContract.ts has ${JSON.stringify(declared)}, the source declares ${JSON.stringify(actual)}`);
  };
  const sorted = (fields: Record<string, string>) => Object.fromEntries(Object.entries(fields).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  for (const [event, fields] of Object.entries(source.payloads)) compare(`PLUGIN_EVENT_PAYLOAD_FIELDS['${event}']`, sorted(written.events.payloads[event] ?? {}), sorted(fields));
  compare('PLUGIN_EVENT_ENVELOPE_FIELDS', sorted(written.events.envelope), sorted(source.envelope));
  return mismatches;
}

/** The text of a shared source file with `search` replaced (which must occur), for override-based tests. */
export function editedSource(file: string, search: string, replacement: string): Record<string, string> {
  const text = readFileSync(file, 'utf8');
  if (!text.includes(search)) throw new Error(`${file} does not contain ${JSON.stringify(search)}`);
  return { [file]: text.replace(search, replacement) };
}
