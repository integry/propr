import { z } from 'zod';

/**
 * Local MCP servers installed from a public package registry: an exact
 * version, pinned by the integrity value ProPR resolves when the item is
 * saved, run through the stdio bridge inside the task container. Only npm is
 * supported: the agent image ships Node, and PyPI servers would need a Python
 * runtime in it.
 */
export const EXTENSION_PACKAGE_ECOSYSTEMS = ['npm'] as const;
export type ExtensionPackageEcosystem = typeof EXTENSION_PACKAGE_ECOSYSTEMS[number];
export const EXTENSION_PACKAGE_LIMITS = { args: 64, argBytes: 2048, env: 32, envValueBytes: 4096, secretEnv: 16 } as const;

/** npm package names, scoped or not, lowercase as the registry requires. */
export const extensionPackageNameSchema = z.string().max(214).regex(/^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/, 'Enter an npm package name');
/** An exact semantic version: ranges, tags (`latest`, `^1.2`) and build metadata are rejected. */
export const EXACT_VERSION_PATTERN = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;
export const extensionPackageVersionSchema = z.string().max(256).regex(EXACT_VERSION_PATTERN, 'Enter an exact version such as 1.2.3; ranges and tags are not accepted');
/** The registry's Subresource Integrity value of the package tarball. Only SHA-512 is accepted. */
export const extensionPackageIntegritySchema = z.string().regex(/^sha512-[A-Za-z0-9+/]{86}==$/);
export const extensionPackageBinSchema = z.string().regex(/^[A-Za-z0-9@._-]{1,128}$/).refine(v => v !== '.' && v !== '..');

/**
 * Variables a launch sets itself or that change how the runtime loads code.
 * A package server cannot override them.
 */
const RESERVED_ENV = new Set(['PATH', 'HOME', 'NODE_OPTIONS', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_REPL_EXTERNAL_MODULE',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'SHELL', 'BASH_ENV', 'ENV', 'IFS', 'PS4', 'SSL_CERT_FILE', 'SSL_CERT_DIR']);
export const extensionPackageEnvNameSchema = z.string().regex(/^[A-Z_][A-Z0-9_]{0,99}$/, 'Use uppercase letters, digits and _')
  .refine(name => !RESERVED_ENV.has(name) && !/^(LD_|DYLD_|NPM_|PROPR_|npm_)/.test(name), 'This variable name is reserved');
// eslint-disable-next-line no-control-regex -- launch arguments and values never carry NUL or line breaks
const plainText = (max: number) => z.string().max(max).regex(/^[^\x00\r\n]*$/);
export const extensionPackageArgsSchema = z.array(plainText(EXTENSION_PACKAGE_LIMITS.argBytes)).max(EXTENSION_PACKAGE_LIMITS.args);
export const extensionPackageEnvSchema = z.array(z.strictObject({ name: extensionPackageEnvNameSchema, value: plainText(EXTENSION_PACKAGE_LIMITS.envValueBytes) })).max(EXTENSION_PACKAGE_LIMITS.env);
export const extensionPackageSecretEnvSchema = z.array(extensionPackageEnvNameSchema).max(EXTENSION_PACKAGE_LIMITS.secretEnv);

/** Fields a package server adds to every library item's fields. */
export const packageServerFields = {
  kind: z.literal('package'),
  ecosystem: z.enum(EXTENSION_PACKAGE_ECOSYSTEMS),
  package: extensionPackageNameSchema,
  version: extensionPackageVersionSchema,
  /** Resolved by ProPR on save; never entered by the administrator. Absent only in a save request. */
  integrity: extensionPackageIntegritySchema.optional(),
  bin: extensionPackageBinSchema.optional(),
  args: extensionPackageArgsSchema.default([]),
  env: extensionPackageEnvSchema.default([]),
  secretEnv: extensionPackageSecretEnvSchema.default([]),
};

/** Duplicate or overlapping variable names of one package server, or null. */
export function extensionPackageEnvConflict(server: { env: { name: string }[]; secretEnv: string[] }): string | null {
  const names = [...server.env.map(e => e.name), ...server.secretEnv];
  const seen = new Set<string>();
  for (const name of names) { if (seen.has(name)) return name; seen.add(name); }
  return null;
}

/** Key of one package server secret variable in the library's sealed credentials and secret replacements. */
export const extensionPackageSecretKey = (server: string, variable: string) => `${server}/${variable}`;

/** What "Check" and a save resolve from the registry. Nothing is executed. */
export interface ExtensionPackageResolution {
  ecosystem: ExtensionPackageEcosystem;
  package: string;
  version: string;
  integrity: string;
  /** The executable that will run, and every executable the package declares. */
  bin: string;
  bins: string[];
}

/** Who acknowledged that a local server's secret variables are readable inside the task container, and when. */
export interface ExtensionSecretAcknowledgement {
  actor: string;
  at: number;
  /** What was acknowledged: the package, version and secret variable names. */
  package: string;
  version: string;
  secretEnv: string[];
}
