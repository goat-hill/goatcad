import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import yaml from '@rollup/plugin-yaml'
import { execFileSync } from 'child_process'

/**
 * What Share app feedback reports as the build (main/feedback.ts). A source
 * build can copy this as easily as it builds, so it says what a reporter is
 * running, not that they are honest.
 */
const buildStamp = (): { official: boolean; commit: string | null } => {
  let commit = process.env.GITHUB_SHA ?? null
  if (!commit) {
    try {
      commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    } catch {
      // Built outside a checkout (a source tarball): no commit to report.
    }
  }
  return {
    official: process.env.GOATCAD_OFFICIAL_BUILD === '1',
    commit: commit?.slice(0, 12) ?? null
  }
}

export default defineConfig({
  // electron-vite's default is minify: false, which ships every identifier and
  // source comment. Minified, none of the three carries either; property names
  // and string literals remain. Bytecode for main is deliberately off (RELEASES.md §9).
  main: {
    build: { minify: 'esbuild' },
    define: { __GOATCAD_BUILD__: JSON.stringify(buildStamp()) }
  },
  preload: { build: { minify: 'esbuild' } },
  renderer: {
    build: { minify: 'esbuild' },
    // With named exports on, Vite emits a JSON import as an object literal,
    // and V8 spent ~1 s of every launch parsing the NewStroke font's 48k keys.
    // Off, a large file ships as JSON.parse("…"), which costs a few ms.
    json: { namedExports: false },
    // Module workers: the board worker loads Clipper's wasm with a dynamic
    // import, which the default single-file worker bundle cannot split.
    worker: { format: 'es' },
    // Cross-origin isolated, as main/appProtocol.ts serves the built app: the
    // board worker shares memory with the page, which Chromium allows only then.
    server: {
      headers: {
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp'
      }
    },
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    // `yaml` lets locale files carry translator context as comments. It is a
    // build-time loader only: YAML is parsed to a plain object here, so nothing
    // reaches the app at runtime that JSON would not have. Keep this in sync
    // with vitest.config.ts, which needs the same loader to import locales.
    plugins: [vue(), yaml()]
  }
})
