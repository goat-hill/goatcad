import './assets/main.css'

import { createApp } from 'vue'
import App from './App.vue'
import { i18n } from './i18n'
import { installToolbarFocus, installToolbarTips } from './lib/canvasToolbar'
import { installMiddlePasteGuard } from './lib/middlePaste'
import { installTestHooks } from './lib/testHooks'
import { setAppTheme } from './lib/theme'
import { loadClipper } from './lib/geometry/clip'

// Every static import has evaluated by here (bin/launch-timing reads `launch:*`).
performance.mark('launch:renderer-evaluated')

// Attaches window.__goatcad only under the screenshot/record harness; no-op otherwise.
installTestHooks()
installToolbarTips()
installToolbarFocus()
installMiddlePasteGuard()

// The geometry engine loads beside the launch, not before it: what needs it
// (a board's load, a footprint's scene, an export) waits for it there.
loadClipper().catch((error: unknown) => console.error('The geometry engine did not load:', error))

// Before mount, so the first frame is already in the saved theme.
setAppTheme(window.api.initialTheme)

createApp(App).use(i18n).mount('#app')
performance.mark('launch:mounted')
