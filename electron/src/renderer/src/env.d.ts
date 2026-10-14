/// <reference types="vite/client" />
/// <reference types="@webgpu/types" />

/**
 * Locale files are YAML so they can carry translator context as comments.
 * `@rollup/plugin-yaml` (see electron.vite.config.ts and vitest.config.ts)
 * parses them to plain objects at build time.
 */
declare module '*.yaml' {
  const value: Record<string, unknown>
  export default value
}
