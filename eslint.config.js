import js from '@eslint/js'
import globals from 'globals'
 
export default [
  { ignores: ['node_modules', 'dist', 'coverage'] },
  {
    files: ['src/**/*.js'],
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
      'max-lines': ['warn', { max: 700, skipBlankLines: true, skipComments: true }],
      'complexity': ['warn', { max: 80 }],
      'max-depth': ['warn', { max: 5 }],
      'max-params': ['warn', { max: 5 }],
    },
  },
]
