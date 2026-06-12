// ESLint v9 flat config (replaces the legacy .eslintrc.js).
// Single root config for the whole pnpm workspace: ESLint walks up from each
// package's cwd and finds this file, so `eslint src` in any package picks it up.
// Mirrors the previous setup — eslint:recommended + typescript-eslint
// recommended, applied to .ts/.tsx only, with the same four rule overrides.
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
    {
        // Build output, deps, type decls, and non-TS sources are never linted.
        // The legacy config ignored `*.js`; we extend that to the whole JS family
        // so only first-party TypeScript is checked (this config file included).
        ignores: [
            '**/dist/**',
            '**/node_modules/**',
            '**/*.d.ts',
            '**/*.js',
            '**/*.cjs',
            '**/*.mjs',
            '**/*.jsx',
            'examples/**',
        ],
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        files: ['**/*.ts', '**/*.tsx'],
        languageOptions: {
            ecmaVersion: 2020,
            sourceType: 'module',
            // env: { node, es6 } in eslintrc terms — keeps process/console/etc.
            // from tripping no-undef.
            globals: {
                ...globals.node,
                ...globals.es2021,
            },
            parserOptions: {
                // chrome-extension lints .tsx; enable JSX parsing for it.
                ecmaFeatures: { jsx: true },
            },
        },
        rules: {
            '@typescript-eslint/no-unused-vars': [
                'error',
                {
                    argsIgnorePattern: '^_',
                    // The `const { a, b, ...rest } = obj` key-omit idiom: `a`/`b`
                    // exist only to exclude keys from `rest`, so they read as
                    // "unused" but are load-bearing. This is the standard option.
                    ignoreRestSiblings: true,
                },
            ],
            '@typescript-eslint/explicit-function-return-type': 'off',
            '@typescript-eslint/explicit-module-boundary-types': 'off',
            '@typescript-eslint/no-explicit-any': 'warn',
        },
    },
    {
        // These files interop with CommonJS modules that ship no type
        // declarations (native tree-sitter grammar addons) or use lazy
        // `require()` to break circular imports between the Context and its
        // splitters. Converting to ESM `import` would force `@ts-ignore` or
        // eager-load native bindings — `require()` is the correct tool here.
        files: ['**/splitter/ast-splitter.ts', '**/context.ts'],
        rules: {
            '@typescript-eslint/no-require-imports': 'off',
        },
    },
);
