/// <reference types="electron-vite/node" />

// occt-import-js ships no typings; this is the minimal surface we call.
// The import result is `unknown` on purpose — `stepMesh.ts` validates the
// shape defensively rather than trusting the wasm module's output.
declare module 'occt-import-js' {
  export interface OcctImportModule {
    ReadStepFile(content: Uint8Array, params: Record<string, unknown> | null): unknown
  }
  const init: (options?: Record<string, unknown>) => Promise<OcctImportModule>
  export default init
}

/**
 * Stamped by electron.vite.config.ts. `official` is set only by release.yml's
 * build (GOATCAD_OFFICIAL_BUILD), so every other build reports itself as source.
 */
declare const __GOATCAD_BUILD__: { official: boolean; commit: string | null }
