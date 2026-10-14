<script lang="ts">
import { defineComponent, h, type PropType } from 'vue'
import { ICONS, type IconDef, type IconName } from '../../lib/icons'

/**
 * Renders a glyph from the icon registry (lib/icons.ts) as `<Icon name="…" />`.
 *
 * Color and size are inherited from the call site: the rendered `<svg>` keeps
 * any class the caller passes, so the container CSS in assets/main.css
 * (`.activity-btn svg`, `.tab-icon svg`, …) sizes and colors it exactly as the
 * inline SVG it replaces did. `fill` defaults to `currentColor`; a caller can
 * override any presentation attribute (e.g. `<Icon name="manufacture" fill="#cca250" />`)
 * and it wins over the registry default.
 *
 * A line-art glyph (registry `fill: 'none'`) has that pinned as an inline
 * style: container rules like `.activity-btn svg { fill: currentColor }` are
 * written for the fill glyphs and would otherwise flood an outline, since CSS
 * beats a presentation attribute. Tint a line-art glyph with `color`.
 *
 * A render function (not a template) is used so the registry's inner markup can
 * be set via `innerHTML` without tripping `vue/no-v-html`.
 */
export default defineComponent({
  name: 'Icon',
  inheritAttrs: false,
  props: {
    name: { type: String as PropType<IconName>, required: true }
  },
  setup(props, { attrs }) {
    return () => {
      const def: IconDef = ICONS[props.name]
      const style = def.fill === 'none' ? [{ fill: 'none' }, attrs.style] : attrs.style
      return h('svg', {
        viewBox: def.viewBox,
        fill: def.fill ?? 'currentColor',
        stroke: def.stroke,
        'stroke-width': def.strokeWidth,
        'stroke-linecap': def.strokeLinecap,
        'stroke-linejoin': def.strokeLinejoin,
        innerHTML: def.body,
        ...attrs,
        style
      })
    }
  }
})
</script>
