import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

/**
 * Plugin code (`packages/plugins/**`: handlers, the registry and the test kit)
 * may import nothing from ProPR but `@propr/shared`, which holds the plugin SDK
 * types. Handlers touch ProPR only through `ctx`, so the same plugin can later
 * run out of process.
 */
const PLUGIN_IMPORT_MESSAGE = 'Plugin code may import only @propr/shared (including the plugin SDK types); use ctx to reach ProPR.'
// From packages/plugins/<folder>/, sibling packages are two levels up and the repository root three.
const OTHER_PACKAGE = '^(?:\\.\\./){2,}(?:core|api|cli|client|local-setup|shared)(?:/|$)'
const ROOT_SOURCES = '^(?:\\.\\./){3,}(?:src|propr-ui|packages|scripts)(?:/|$)'
const pluginImportRules = {
  'no-restricted-imports': ['error', {
    patterns: [
      { group: ['@propr/*', '!@propr/shared', '!@propr/shared/*'], message: PLUGIN_IMPORT_MESSAGE },
      { group: ['propr-ui', 'propr-ui/*'], message: PLUGIN_IMPORT_MESSAGE },
      // Relative paths out of the plugins package into another ProPR package or the root sources.
      { regex: OTHER_PACKAGE, message: PLUGIN_IMPORT_MESSAGE },
      { regex: ROOT_SOURCES, message: PLUGIN_IMPORT_MESSAGE },
    ],
  }],
  'no-restricted-syntax': ['error', ...[
    'ImportExpression[source.value=/^@propr\\/(?!shared(?:$|\\/))/]',
    `ImportExpression[source.value=/${OTHER_PACKAGE.replaceAll('/', '\\/')}/]`,
    `ImportExpression[source.value=/${ROOT_SOURCES.replaceAll('/', '\\/')}/]`,
  ].map(selector => ({ selector, message: PLUGIN_IMPORT_MESSAGE }))],
}

export default [
  { ignores: ['node_modules', '**/dist', 'coverage'] },
  {
    files: ['src/**/*.js', 'src/**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': ['error', { varsIgnorePattern: '^_', argsIgnorePattern: '^_' }],
      'max-lines': ['warn', { max: 400, skipBlankLines: true, skipComments: true }],
      'complexity': ['warn', { max: 20 }],
      'max-depth': ['warn', { max: 4 }],
      'max-params': ['warn', { max: 4 }],
    },
  },
  ...tseslint.configs.recommended.map(config => ({
    ...config,
    files: ['src/**/*.ts'],
  })),
  {
    files: ['packages/plugins/**/*.ts', 'packages/plugins/**/*.js', 'packages/plugins/**/*.mjs'],
    languageOptions: {
      parser: tseslint.parser,
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: pluginImportRules,
  },
]
