/**
 * `render.model` — a picture of one 3D model, alone.
 *
 * It exists
 * because no agent harness opens a STEP file on any platform — the same
 * reasoning that produced `parts_read_datasheet`. Four fixed views, drawn by the
 * app's own STEP worker and 3D scene, so every platform gets the same picture.
 */
import { defineDesignOp } from '../registry'
import { s } from '../schema'
import { refused } from '../errors'

/** Both tiles of a row plus both of the other: the default is a 2×2 grid of
 *  512 px tiles, which reads a small part's pin 1 chamfer. */
export const RENDER_MODEL_DEFAULT_MAX_PIXELS = 1024

export const renderModel = defineDesignOp({
  name: 'render.model',
  scope: 'project',
  mutates: false,
  summary:
    'Render one 3D model file to a PNG in four views (top, front, right, angled) at one scale.',
  guidance:
    'Check a model before attaching it. Drawn in its own frame with no footprint transform; render_footprint with view model shows it on the pads.',
  input: s.object({
    path: s
      .string()
      .trim()
      .describe(
        'A path as a footprint links it (${KIPRJMOD}/…, ${KICAD9_3DMODEL_DIR}/…), or an absolute file path.'
      ),
    maxPixels: s
      .integer()
      .min(256)
      .max(4096)
      .describe(
        `Longest edge of the 2×2 picture, pixels. Defaults to ${RENDER_MODEL_DEFAULT_MAX_PIXELS}.`
      )
      .optional()
  }),
  examples: [
    {
      args: { path: '${KIPRJMOD}/board.3dshapes/SOT-23-5.step' },
      note: 'a cached model'
    }
  ],
  request(args) {
    if (!args.path) {
      return refused(
        'path is required and must not be empty.',
        "Pass the path footprint_get reports under models[].path, footprint_cache_model's model.path, or an absolute file path."
      )
    }
    return {
      kind: 'render-model',
      path: args.path,
      maxPixels: args.maxPixels ?? RENDER_MODEL_DEFAULT_MAX_PIXELS
    }
  }
})
