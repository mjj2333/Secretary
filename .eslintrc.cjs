/* eslint-env node */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint', 'import'],
  extends: ['airbnb-base', 'plugin:@typescript-eslint/recommended', 'prettier'],
  settings: {
    'import/resolver': {
      node: {
        extensions: ['.js', '.ts'],
      },
      typescript: {
        alwaysTryTypes: true,
      },
    },
  },
  rules: {
    'import/prefer-default-export': 'off',
    'import/extensions': 'off',
    'import/no-unresolved': 'off',
    'import/no-extraneous-dependencies': 'off',
    'no-console': ['warn', { allow: ['warn', 'error'] }],
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    // airbnb-base targets legacy JS; the rules below conflict with this codebase's
    // intentional modern-TypeScript style and are relaxed deliberately.
    'no-void': 'off', // `void promise` for fire-and-forget is intentional
    'no-bitwise': 'off', // byte-level crypto operations
    'max-classes-per-file': 'off', // errors.ts groups the SecretaryError hierarchy
    'lines-between-class-members': ['error', 'always', { exceptAfterSingleLine: true }],
    'no-use-before-define': ['error', { functions: false, classes: true, variables: true }],
    'no-restricted-syntax': ['error', 'ForInStatement', 'LabeledStatement', 'WithStatement'], // allow for-of
    'no-return-assign': ['error', 'except-parens'],
    'no-promise-executor-return': 'off', // listen()/setTimeout promise wrappers
    'no-loop-func': 'off', // safe with per-iteration const bindings
    'class-methods-use-this': 'off', // small private helpers needn't touch `this`
    'no-useless-constructor': 'off', // TS parameter-property constructors are not useless
    '@typescript-eslint/no-useless-constructor': 'error',
    'no-empty-function': ['error', { allow: ['arrowFunctions', 'constructors'] }],
  },
  overrides: [
    {
      // Dev CLI helpers legitimately print to the console.
      files: ['**/scripts/**', '**/test/manual/**'],
      rules: { 'no-console': 'off' },
    },
  ],
  ignorePatterns: [
    'dist/',
    'build/',
    'out/',
    'release/',
    'node_modules/',
    '*.cjs',
    '*.config.js',
    '*.config.ts',
    'coverage/',
  ],
};
