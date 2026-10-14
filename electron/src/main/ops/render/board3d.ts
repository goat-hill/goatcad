/**
 * `render.board_3d` — the board as the thing that will arrive: a 3D
 * render of the assembled board from any camera.
 *
 * `render.board` is the layout as the editor draws it, for reading
 * placement and copper; this is the board as an object — mask and silk in
 * their stackup colors, parts standing on it — for judging how it looks and
 * for pictures a person wants. The camera, size, what is drawn, the light and
 * the background are all the caller's; zoom 1 fits what is framed.
 * Anything past this (a scene to light and render yourself) is a 3D export,
 * not more options here.
 */
import { defineDesignOp } from '../registry'
import { s } from '../schema'
import { BOARD_FILE } from '../fileArgs'

const VIEWS = ['iso', 'top', 'bottom', 'front', 'back', 'left', 'right'] as const

export const renderBoard3d = defineDesignOp({
  name: 'render.board_3d',
  scope: 'board',
  mutates: false,
  summary: 'Render the assembled board in 3D to a PNG, from any camera, at any size.',
  guidance:
    "Draws substrate, copper, mask and silk in the stackup's colors, paste, plated holes and part models as the 3D pane does, from the file or the tab's unsaved buffer; the 3D pane is untouched. mask and silk preview a finish and write nothing. Camera: a view preset, or azimuth and elevation, plus roll, projection and fov. zoom 1 fits what is framed: the board, or footprints, box or center. Give width or height alone and the other follows the framed shape.",
  input: s.object({
    board: s
      .string()
      .trim()
      .describe(`${BOARD_FILE}; omit for the project's one board.`)
      .optional(),
    view: s
      .enum(VIEWS)
      .describe(
        "Camera preset. iso (default): the 3D pane's three-quarter view from the front right, about 30° up. bottom shows the board mirrored, turned over."
      )
      .optional(),
    azimuth: s
      .number()
      .describe(
        'Degrees around the board, overriding the preset: 0 from the front (bottom edge), 90 right, 180 back, -90 left.'
      )
      .optional(),
    elevation: s
      .number()
      .min(-90)
      .max(90)
      .describe(
        "Degrees above the board's plane, overriding the preset: 90 straight down, 0 edge-on, negative from below."
      )
      .optional(),
    roll: s.number().describe('Degrees about the view axis.').optional(),
    projection: s
      .enum(['perspective', 'orthographic'] as const)
      .describe('Default perspective; orthographic keeps one scale and answers mmPerPixel.')
      .optional(),
    fov: s
      .number()
      .min(5)
      .max(120)
      .describe('Vertical field of view in degrees, perspective only; default 45.')
      .optional(),
    zoom: s
      .number()
      .min(0.05)
      .max(1000)
      .describe('1 (default) fits what is framed; 2 is twice as close.')
      .optional(),
    footprints: s.array(s.string().trim()).min(1).describe('Frame these references.').optional(),
    box: s
      .object({ x: s.number(), y: s.number(), width: s.number(), height: s.number() })
      .describe('Frame this rectangle, board mm, y down; wins over footprints.')
      .optional(),
    center: s
      .object({ x: s.number(), y: s.number(), z: s.number().optional() })
      .describe(
        "Look at this point, board mm, y down; z above the board's mid-plane, default its top face."
      )
      .optional(),
    width: s.integer().min(16).max(16384).describe('Picture width in pixels.').optional(),
    height: s.integer().min(16).max(16384).describe('Picture height in pixels.').optional(),
    show: s
      .object({
        boardBody: s.boolean().optional(),
        copper: s.boolean().optional(),
        solderMask: s.boolean().optional(),
        solderPaste: s.boolean().optional(),
        silkscreen: s.boolean().optional(),
        drawings: s.boolean().optional(),
        holes: s.boolean().optional(),
        axes: s.boolean().optional(),
        models: s.boolean().optional(),
        modelsThroughHole: s.boolean().optional(),
        modelsSmd: s.boolean().optional(),
        modelsUnspecified: s.boolean().optional(),
        modelsDnp: s.boolean().optional(),
        modelsNotInPosFiles: s.boolean().optional()
      })
      .describe(
        "Layers and part classes, named as the 3D pane's options. Default all on except drawings (comment layers), axes, modelsDnp and modelsNotInPosFiles. models false leaves the bare board."
      )
      .optional(),
    hide: s
      .array(s.string().trim())
      .min(1)
      .describe('Leave out the models of these references.')
      .optional(),
    only: s
      .array(s.string().trim())
      .min(1)
      .describe('Draw only the models of these references; the board stays whole.')
      .optional(),
    lighting: s
      .enum(['studio', 'soft', 'flat', 'dramatic'] as const)
      .describe(
        "studio (default): the 3D pane's light. soft: no key light, even reflections. flat: every face lit alike, colors as named. dramatic: hard key, deep shadows."
      )
      .optional(),
    exposure: s.number().min(0.05).max(8).describe('Light scale; default 1.').optional(),
    background: s
      .string()
      .trim()
      .describe("theme (default, the app's dark green-black), transparent (PNG alpha), or #RRGGBB.")
      .optional(),
    mask: s
      .string()
      .trim()
      .describe(
        "Solder mask color instead of the stackup's: Green, Red, Yellow, Blue, White, Black, Purple or #RRGGBB."
      )
      .optional(),
    silk: s
      .string()
      .trim()
      .describe(
        "Silkscreen color for both sides instead of the stackup's: White, Black, Yellow or #RRGGBB."
      )
      .optional()
  }),
  examples: [
    { args: {}, note: 'whole board, default angle' },
    {
      args: { azimuth: -30, elevation: 35, width: 1920, height: 1080, background: 'transparent' },
      note: '1080p hero shot, transparent'
    },
    {
      args: { mask: 'Black', silk: 'White' },
      note: 'preview a finish'
    }
  ],
  request(args) {
    return {
      kind: 'render-board-3d',
      ...(args.board ? { board: args.board } : {}),
      ...(args.view ? { view: args.view } : {}),
      ...(args.azimuth !== undefined ? { azimuth: args.azimuth } : {}),
      ...(args.elevation !== undefined ? { elevation: args.elevation } : {}),
      ...(args.roll !== undefined ? { roll: args.roll } : {}),
      ...(args.projection ? { projection: args.projection } : {}),
      ...(args.fov !== undefined ? { fov: args.fov } : {}),
      ...(args.zoom !== undefined ? { zoom: args.zoom } : {}),
      ...(args.footprints ? { footprints: args.footprints } : {}),
      ...(args.box ? { box: args.box } : {}),
      ...(args.center ? { center: args.center } : {}),
      ...(args.width !== undefined ? { width: args.width } : {}),
      ...(args.height !== undefined ? { height: args.height } : {}),
      ...(args.show ? { show: args.show } : {}),
      ...(args.hide ? { hide: args.hide } : {}),
      ...(args.only ? { only: args.only } : {}),
      ...(args.lighting ? { lighting: args.lighting } : {}),
      ...(args.exposure !== undefined ? { exposure: args.exposure } : {}),
      ...(args.background ? { background: args.background } : {}),
      ...(args.mask ? { mask: args.mask } : {}),
      ...(args.silk ? { silk: args.silk } : {})
    }
  }
})
