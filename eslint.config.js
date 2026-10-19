import eslint from '@eslint/js';
import stylistic from '@stylistic/eslint-plugin';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// Loops are allowed only when array methods cannot express the logic
// (for example `for await` over an async iterator). Disable the rule on that
// line with a comment that says why.
const LOOP_RESTRICTIONS = [
    {
        selector: 'ForStatement',
        message: 'Use .map, .forEach, .reduce or another array method instead of a for loop.',
    },
    {
        selector: 'ForInStatement',
        message: 'Use Object.keys/values/entries with an array method instead of for...in.',
    },
    {
        selector: 'ForOfStatement[await=false]',
        message: 'Use .map, .forEach, .reduce or another array method instead of for...of.',
    },
    {
        selector: 'WhileStatement',
        message: 'Use an array method or recursion instead of a while loop.',
    },
    {
        selector: 'DoWhileStatement',
        message: 'Use an array method or recursion instead of a do...while loop.',
    },
];

// Save a call result in a named const before passing it to another call.
// Callbacks (arrow functions) are fine, nested calls are not.
const NESTED_CALL_RESTRICTIONS = [
    {
        selector: 'CallExpression > CallExpression.arguments',
        message: 'Store the inner call result in a named const and pass the const instead.',
    },
    {
        selector: 'NewExpression > CallExpression.arguments',
        message: 'Store the inner call result in a named const and pass the const instead.',
    },
];

// Declarations are never exported in place. Each file ends with one
// `export { ... };` (and `export type { ... };`) list.
const EXPORT_RESTRICTIONS = [
    {
        selector: 'ExportNamedDeclaration[declaration!=null]',
        message: 'Declare without export and add the name to the export list at the end of the file.',
    },
    {
        selector: 'ExportNamedDeclaration[source=null] ~ :not(ExportNamedDeclaration)',
        message: 'Export lists go at the end of the file.',
    },
];

const STYLISTIC_CONFIG = stylistic.configs.customize({
    indent: 4,
    quotes: 'single',
    semi: true,
    commaDangle: 'always-multiline',
    braceStyle: '1tbs',
});

export default defineConfig(
    {
        ignores: ['dist', 'coverage', 'node_modules', 'demo/dist'],
    },
    eslint.configs.recommended,
    tseslint.configs.strictTypeChecked,
    STYLISTIC_CONFIG,
    {
        languageOptions: {
            parserOptions: {
                projectService: true,
                tsconfigRootDir: import.meta.dirname,
            },
            globals: {
                ...globals.browser,
            },
        },
        rules: {
            'no-var': 'error',
            'prefer-const': 'error',
            'curly': ['error', 'all'],
            'eqeqeq': ['error', 'always'],
            'id-length': ['error', { min: 2, exceptions: ['_'], properties: 'never' }],
            '@stylistic/newline-per-chained-call': ['error', { ignoreChainWithDepth: 1 }],
            '@stylistic/padding-line-between-statements': [
                'error',
                { blankLine: 'always', prev: '*', next: 'return' },
                { blankLine: 'always', prev: ['const', 'let'], next: '*' },
                { blankLine: 'any', prev: ['const', 'let'], next: ['const', 'let'] },
            ],
            '@typescript-eslint/naming-convention': [
                'error',
                { selector: 'default', format: ['camelCase'], leadingUnderscore: 'allow' },
                { selector: 'variable', format: ['camelCase', 'UPPER_CASE'] },
                { selector: 'typeLike', format: ['PascalCase'] },
                { selector: 'enumMember', format: ['UPPER_CASE'] },
                { selector: 'import', format: ['camelCase', 'PascalCase'] },
                { selector: ['objectLiteralProperty', 'typeProperty'], format: null },
            ],
            '@typescript-eslint/consistent-type-imports': 'error',
            '@typescript-eslint/explicit-function-return-type': ['error', { allowExpressions: true }],
            'no-restricted-syntax': ['error', ...LOOP_RESTRICTIONS, ...NESTED_CALL_RESTRICTIONS, ...EXPORT_RESTRICTIONS],
        },
    },
    {
        files: ['**/*.test.ts', '**/*.test.tsx', 'test/**'],
        rules: {
            'no-restricted-syntax': ['error', ...LOOP_RESTRICTIONS, ...EXPORT_RESTRICTIONS],
            '@typescript-eslint/no-non-null-assertion': 'off',
        },
    },
    {
        files: ['*.config.ts'],
        rules: {
            '@typescript-eslint/naming-convention': 'off',
        },
    },
    {
        files: ['**/*.js'],
        extends: [tseslint.configs.disableTypeChecked],
        rules: {
            '@typescript-eslint/naming-convention': 'off',
            '@typescript-eslint/explicit-function-return-type': 'off',
        },
    },
);
