/**
 * `export.profiles` — what each fab takes, as the writers' arguments, with the
 * pages each setting is held to and what no page has confirmed yet.
 */
import { defineDesignOp } from '../registry'
import { s } from '../schema'

export const exportProfiles = defineDesignOp({
  name: 'export.profiles',
  scope: 'board',
  mutates: false,
  summary:
    "List the fab export profiles, or read one: each output's format, its sources and open questions.",
  guidance:
    "formats holds the arguments export_gerbers, export_drill, export_bom and export_positions take; archive, the outputs zipped together. sources are the fab's pages behind the settings; todo is what none confirms, left at writer defaults: tell the user before an order relies on it. export_package runs a profile; for a fab not listed, pass it the formats yourself.",
  input: s.object({
    profile: s
      .string()
      .trim()
      .describe('Profile id to read in full, e.g. jlcpcb; omit to list them.')
      .optional()
  }),
  examples: [
    { args: {}, note: 'list profiles' },
    { args: { profile: 'jlcpcb' }, note: 'one with its formats' }
  ],
  request: ({ profile }) => ({ kind: 'export-profiles', ...(profile ? { profile } : {}) })
})
