/**
 * `viewport.close` — take an agent's box off the person's canvas
 * (docs/agent-api.md, "The agent viewport").
 */
import { defineDesignOp } from '../registry'
import { s } from '../schema'

export const viewportClose = defineDesignOp({
  name: 'viewport.close',
  scope: 'project',
  mutates: false,
  summary: "Close a viewport: its box leaves the user's canvas.",
  guidance:
    'Close your viewport when its block of work is done. Ends any routing session in it, landing what it had clicked, as Esc does.',
  input: s.object({
    viewport: s.string().trim().describe('The viewport id viewport_open answered.')
  }),
  examples: [{ args: { viewport: 'viewport-1' }, note: 'done there' }],
  request: (args) => ({ kind: 'close-viewport', viewport: args.viewport })
})
