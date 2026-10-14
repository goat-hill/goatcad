import { loadClipper } from './src/renderer/src/lib/geometry/clip'

// The app loads the geometry engine at launch and everything that needs it
// waits for it there; a test starts with it loaded, as the app's work does.
await loadClipper()
