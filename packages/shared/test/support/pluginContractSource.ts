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
 *   the input envelopes, the signatures of the functions and classes the SDK
 *   module exports (`definePluginHandler`, `PluginDeliveryError`'s constructor
 *   and members, …) and every shared interface or type alias they reach
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
  /** The SDK interfaces plugins supply (see `PluginContract['sdk']['suppliedTypes']`). */
  suppliedTypes: string[];
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

/**
 * A declaration's type reduced to a contract descriptor, as `PLUGIN_EVENT_PAYLOAD_FIELDS` writes it.
 * `undefined` is kept (after `null`), so `score: number | undefined` is not read as `score: number`; only
 * an optional property drops it (`optionalProperty`), because its `?` key already says it may be absent.
 */
function descriptor(checker: ts.TypeChecker, type: ts.Type, { optionalProperty = false } = {}): string {
  const parts = type.isUnion() ? type.types : [type];
  const nullable = parts.some(part => part.flags & ts.TypeFlags.Null);
  const undefinable = !optionalProperty && parts.some(part => part.flags & ts.TypeFlags.Undefined);
  const names = [...new Set(parts.filter(part => !(part.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined))).map(part => baseDescriptor(checker, part)))].sort();
  return [...names, ...(nullable ? ['null'] : []), ...(undefinable ? ['undefined'] : [])].join(' | ');
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
    fields[optional ? `${property.name}?` : property.name] = descriptor(checker, checker.getTypeOfSymbolAtLocation(property, declaration), { optionalProperty: optional });
  }
  return fields;
}

const print = (node: ts.Node, file: ts.SourceFile) => printer.printNode(ts.EmitHint.Unspecified, node, file).replace(/\s+/g, ' ').replace(/;\s*}/g, ' }').trim();
/** `<T>(a: A) => R`; without a written result type, the one the checker infers (when given one), else `void`. */
const signatureText = (node: ts.SignatureDeclaration, file: ts.SourceFile, checker?: ts.TypeChecker) => {
  const typeParameters = node.typeParameters ? `<${node.typeParameters.map(p => print(p, file)).join(', ')}>` : '';
  const inferred = () => {
    const signature = checker!.getSignatureFromDeclaration(node);
    return signature ? checker!.typeToString(checker!.getReturnTypeOfSignature(signature), undefined, ts.TypeFormatFlags.NoTruncation) : 'void';
  };
  return `${typeParameters}(${node.parameters.map(p => print(p, file)).join(', ')}) => ${node.type ? print(node.type, file) : checker ? inferred() : 'void'}`;
};

const isExported = (node: ts.Node) => ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some(m => m.kind === ts.SyntaxKind.ExportKeyword);
const isPublic = (node: ts.Node) => !(ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some(m => m.kind === ts.SyntaxKind.PrivateKeyword || m.kind === ts.SyntaxKind.ProtectedKeyword));
const isReadonly = (node: ts.Node) => ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some(m => m.kind === ts.SyntaxKind.ReadonlyKeyword);

/**
 * The runtime functions and classes the SDK module exports, which plugins call and construct
 * (`definePluginHandler`, `new PluginDeliveryError(…)`, …): `name()` → a function's signature;
 * `Class.constructor`, `Class.member` and `Class extends` for a class. Each signature node is
 * returned too, so the walk records the shared types it names: the parameters (which plugins supply)
 * with their polarity, and the results without it. A result is not always the plugin's to use:
 * `definePluginHandler` hands its result straight back to ProPR, so the `ctx` that handler receives
 * is not something plugins supply.
 */
function sdkExports(checker: ts.TypeChecker, sdk: ts.SourceFile): { types: Record<string, string>; reached: ts.Node[]; returned: ts.Node[] } {
  const types: Record<string, string> = {};
  const reached: ts.Node[] = [];
  const returned: ts.Node[] = [];
  const signature = (key: string, node: ts.SignatureDeclaration) => {
    types[key] = types[key] ? `${types[key]} & ${signatureText(node, sdk, checker)}` : signatureText(node, sdk, checker);
    reached.push(...(node.typeParameters ?? []), ...node.parameters);
    if (node.type) returned.push(node.type);
  };
  const typeOf = (node: ts.Node) => checker.typeToString(checker.getTypeAtLocation(node), undefined, ts.TypeFormatFlags.NoTruncation);
  for (const statement of sdk.statements) {
    if (!isExported(statement)) continue;
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      const overloads = sdk.statements.filter((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === statement.name!.text && !s.body);
      // With overloads, callers see the overload signatures, not the implementation's.
      if (!statement.body || !overloads.length) signature(`${statement.name.text}()`, statement);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        const initializer = declaration.initializer;
        if (declaration.type && ts.isFunctionTypeNode(declaration.type)) signature(`${declaration.name.text}()`, declaration.type);
        else if (initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))) signature(`${declaration.name.text}()`, initializer);
      }
    } else if (ts.isClassDeclaration(statement) && statement.name) {
      const name = statement.name.text;
      for (const clause of statement.heritageClauses ?? []) {
        types[`${name} ${clause.token === ts.SyntaxKind.ExtendsKeyword ? 'extends' : 'implements'}`] = clause.types.map(t => print(t, sdk)).join(', ');
        reached.push(clause);
      }
      for (const member of statement.members) {
        if (!isPublic(member) || (member.name && ts.isPrivateIdentifier(member.name))) continue;
        const prefix = ts.canHaveModifiers(member) && (ts.getModifiers(member) ?? []).some(m => m.kind === ts.SyntaxKind.StaticKeyword) ? `${name}.static ` : `${name}.`;
        if (ts.isConstructorDeclaration(member)) {
          signature(`${name}.constructor`, member);
          // `constructor(readonly code: …)` declares a public property too.
          for (const parameter of member.parameters) {
            if (ts.isIdentifier(parameter.name) && ts.isParameterPropertyDeclaration(parameter, member) && isPublic(parameter)) {
              types[`${name}.${parameter.name.text}${parameter.questionToken ? '?' : ''}`] = `${isReadonly(parameter) ? 'readonly ' : ''}${parameter.type ? print(parameter.type, sdk) : typeOf(parameter)}`;
            }
          }
        } else if (ts.isPropertyDeclaration(member)) {
          types[`${prefix}${member.name.getText(sdk)}${member.questionToken ? '?' : ''}`] = `${isReadonly(member) ? 'readonly ' : ''}${member.type ? print(member.type, sdk) : typeOf(member)}`;
          if (member.type) reached.push(member.type);
        } else if (ts.isMethodDeclaration(member)) {
          signature(`${prefix}${member.name.getText(sdk)}${member.questionToken ? '?' : ''}`, member);
        } else if (ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) {
          signature(`${prefix}${ts.isGetAccessorDeclaration(member) ? 'get' : 'set'} ${member.name.getText(sdk)}`, member);
        } else if (!ts.isClassStaticBlockDeclaration(member) && !ts.isSemicolonClassElement(member)) {
          throw new Error(`${name}: member kind ${ts.SyntaxKind[member.kind]} is not recorded in the plugin contract`);
        }
      }
    }
  }
  return { types, reached, returned };
}

/**
 * The declared type text of every member of the SDK interfaces, following references into shared sources,
 * and the interfaces plugins supply: those reached through a parameter (an odd number of them, so the
 * argument of a callback ProPR passes to a plugin is received again).
 */
function sdkTypes(program: ts.Program, checker: ts.TypeChecker, sdk: ts.SourceFile): { types: Record<string, string>; supplied: string[] } {
  const types: Record<string, string> = {};
  const supplied = new Set<string>();
  const seen = new Set<string>();
  const declarations = new Map<ts.Declaration, number>();
  // `supplies` null: recorded, but whoever builds it is not known (see `sdkExports`), so never marked supplied.
  const queue: { declaration: ts.Declaration; supplies: boolean | null }[] = SDK_ROOTS.map(name => ({ declaration: interfaceIn(sdk, name), supplies: false }));
  const follow = (node: ts.Node, supplies: boolean | null) => {
    const visit = (child: ts.Node, polarity: boolean | null) => {
      const name = ts.isTypeReferenceNode(child) ? child.typeName : ts.isExpressionWithTypeArguments(child) ? child.expression : undefined;
      if (name) {
        let symbol = checker.getSymbolAtLocation(name);
        if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
        for (const declaration of symbol?.declarations ?? []) {
          const inShared = declaration.getSourceFile().fileName.startsWith(SOURCE) && !program.isSourceFileDefaultLibrary(declaration.getSourceFile());
          if (inShared && (ts.isInterfaceDeclaration(declaration) || ts.isTypeAliasDeclaration(declaration))) queue.push({ declaration, supplies: polarity });
        }
      }
      // A parameter's type is what the other side supplies.
      const inner = ts.isParameter(child) && polarity !== null ? !polarity : polarity;
      ts.forEachChild(child, grandchild => visit(grandchild, inner));
    };
    visit(node, supplies);
  };
  // The exported functions and classes: their signatures, and the shared types those name.
  const exported = sdkExports(checker, sdk);
  Object.assign(types, exported.types);
  for (const node of exported.reached) follow(node, false);
  for (const node of exported.returned) follow(node, null);
  while (queue.length) {
    const { declaration, supplies } = queue.shift()!;
    if (!declarations.has(declaration)) declarations.set(declaration, declarations.size);
    const key = `${declarations.get(declaration)}:${supplies}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const file = declaration.getSourceFile();
    if (ts.isTypeAliasDeclaration(declaration)) {
      const name = declaration.name.text;
      let text = print(declaration.type, file);
      // An alias like `(typeof LIST)[number]` changes with LIST's values, which its text does not show.
      if (/\btypeof\b/.test(text)) text += ` = ${checker.typeToString(checker.getTypeAtLocation(declaration.type), undefined, ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.InTypeAlias)}`;
      types[name] = text;
      follow(declaration.type, supplies);
      continue;
    }
    if (!ts.isInterfaceDeclaration(declaration)) continue;
    const name = declaration.name.text;
    if (supplies) supplied.add(name);
    for (const clause of declaration.heritageClauses ?? []) {
      types[`${name} extends`] = clause.types.map(t => print(t, file)).join(', ');
      follow(clause, supplies);
    }
    for (const member of declaration.members) {
      const optional = 'questionToken' in member && member.questionToken ? '?' : '';
      if (ts.isPropertySignature(member) && member.type) types[`${name}.${member.name.getText(file)}${optional}`] = print(member.type, file);
      else if (ts.isMethodSignature(member)) types[`${name}.${member.name.getText(file)}${optional}`] = signatureText(member, file);
      else if (ts.isIndexSignatureDeclaration(member)) types[`${name}[${member.parameters.map(p => print(p, file)).join(', ')}]`] = member.type ? print(member.type, file) : 'any';
      else if (ts.isCallSignatureDeclaration(member)) types[`${name}()`] = signatureText(member, file);
      else throw new Error(`${name}: member kind ${ts.SyntaxKind[member.kind]} is not recorded in the plugin contract`);
      follow(member, supplies);
    }
  }
  return { types: Object.fromEntries(Object.entries(types).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))), supplied: [...supplied].sort() };
}

/** Read the plugin interface from the sources (with `overrides` replacing file text). */
export function readPluginContractSource({ overrides = {} }: { overrides?: Record<string, string> } = {}): PluginContractSource {
  const program = createProgram(overrides);
  const checker = program.getTypeChecker();
  const events = program.getSourceFile(REPOSITORY_EVENTS_SOURCE)!;
  const sdk = program.getSourceFile(PLUGIN_SDK_SOURCE)!;
  const payloads = Object.fromEntries(Object.entries(PLUGIN_EVENT_PAYLOAD_INTERFACES).map(([event, name]) => [event, fieldDescriptors(checker, interfaceIn(events, name))]));
  const { types, supplied } = sdkTypes(program, checker, sdk);
  return { payloads, envelope: fieldDescriptors(checker, interfaceIn(events, 'RepositoryEvent')), sdkTypes: types, suppliedTypes: supplied };
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
  contract.sdk.suppliedTypes = [...source.suppliedTypes];
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
