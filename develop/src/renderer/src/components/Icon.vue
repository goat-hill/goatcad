<script lang="ts">
import { defineComponent, h, type PropType } from 'vue'
import { ICONS, type IconDef, type IconName } from '../icons'

/**
 * Renders a glyph from the icon registry (icons.ts) as `<Icon name="…" />`.
 *
 * Colour and size are inherited from the call site: the rendered `<svg>` keeps
 * any class the caller passes, so the wrapper CSS in assets/main.css
 * (`.icon`, `.control-btn svg`, `.dirty-icon`, …) styles it exactly as the inline
 * SVG it replaces did. `fill` defaults to `currentColor`; author CSS and any
 * caller-passed attribute win over the registry defaults.
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
      return h('svg', {
        viewBox: def.viewBox,
        fill: def.fill ?? 'currentColor',
        stroke: def.stroke,
        'stroke-width': def.strokeWidth,
        'stroke-linecap': def.strokeLinecap,
        'stroke-linejoin': def.strokeLinejoin,
        innerHTML: def.body,
        ...attrs
      })
    }
  }
})
</script>
