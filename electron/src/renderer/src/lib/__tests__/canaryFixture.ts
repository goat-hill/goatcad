import { resolve } from 'node:path'

/**
 * A real KiCad project for the suites that need one: canary, the 4-layer
 * ESP32-S3 board behind Bitclock, frozen here so a test's counts never move
 * under it. The living sample is in goat-hill/goatcad-sample-projects; this
 * copy changes only when a test needs it to. Two of its footprints come from
 * KiCad's library (CC-BY-SA-4.0 with the KiCad Library Exception), named in
 * fixtures/canary/README.md.
 */
export const CANARY_DIR = resolve(__dirname, 'fixtures/canary')
export const CANARY_BOARD = resolve(CANARY_DIR, 'canary.kicad_pcb')
export const CANARY_SCHEMATIC = resolve(CANARY_DIR, 'canary.kicad_sch')
