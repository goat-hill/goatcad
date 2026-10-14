import { defineConfig } from 'eslint/config'
import tseslint from '@electron-toolkit/eslint-config-ts'
import eslintConfigPrettier from '@electron-toolkit/eslint-config-prettier'
import eslintPluginVue from 'eslint-plugin-vue'
import vueParser from 'vue-eslint-parser'

export default defineConfig(
  // .claude holds agent worktrees (their own projects/toolchains) — not ours to lint.
  // web/ is a self-contained Astro project outside the Electron build; it relies
  // on `astro check` for type safety rather than ESLint (see docs/WEB.md).
  {
    ignores: [
      '**/node_modules',
      '**/dist',
      '**/out',
      '.claude',
      'web',
      // Generated Emscripten loaders (see electron/wasm/*/build.sh).
      'src/renderer/src/lib/geometry/wasm/clipper2.js',
      'src/main/wasm/pdfium.js',
      // Upstream sources fetched by the electron/wasm/*/build.sh scripts, and
      // the plain-node smoke test that exercises a build's outputs.
      'wasm/*/upstream',
      'wasm/*/smoke.mjs'
    ]
  },
  tseslint.configs.recommended,
  eslintPluginVue.configs['flat/recommended'],
  {
    files: ['**/*.vue'],
    languageOptions: {
      parser: vueParser,
      parserOptions: {
        ecmaFeatures: {
          jsx: true
        },
        extraFileExtensions: ['.vue'],
        parser: tseslint.parser
      }
    }
  },
  // electron-builder hooks in build/ are CommonJS Node scripts that it require()s
  // at package time — not app source, not part of the TypeScript build, and never
  // shipped inside the app. They cannot carry TS return annotations, so the two
  // rules that assume a .ts file are off here; everything else still applies.
  {
    files: ['build/**/*.js'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/explicit-function-return-type': 'off'
    }
  },
  {
    files: ['**/*.{ts,mts,tsx,vue}'],
    rules: {
      'vue/require-default-prop': 'off',
      'vue/multi-word-component-names': 'off',
      'vue/block-lang': [
        'error',
        {
          script: {
            lang: 'ts'
          }
        }
      ]
    }
  },
  eslintConfigPrettier
)
