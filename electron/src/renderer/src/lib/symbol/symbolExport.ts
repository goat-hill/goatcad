// Pure helpers for exporting the symbol on screen as a picture (the symbol
// editor's Export as PNG). The picture itself is the schematic capture's
// (`lib/engine/schematicCapture.ts`); these name the file and unwrap the bytes.

import { rebaseReference } from '../kicad/paths'

/** Characters no filesystem the app runs on accepts in a file name. */
const UNSAFE_FILENAME = /[\\/:*?"<>|]/g

/**
 * Where the save dialog starts: `<symbol>.<ext>` beside the library file. A
 * library with no file on disk (a virtual tab, `custom-lib://…`) offers the bare
 * name and lets the dialog pick the folder. A symbol name may hold characters a
 * file name cannot (`Conn_01x02/Pin`), which become `_`.
 */
export const symbolExportPath = (
  libraryPath: string | null | undefined,
  symbolName: string,
  extension: string
): string => {
  const file = `${symbolName.replace(UNSAFE_FILENAME, '_') || 'symbol'}.${extension}`
  return libraryPath && !libraryPath.includes('://') ? rebaseReference(libraryPath, file) : file
}

/** The base64 payload of a `data:…;base64,` URL, or null when it is not one. */
export const dataUrlBase64 = (dataUrl: string): string | null => {
  const match = /^data:[^,]*;base64,/.exec(dataUrl)
  return match ? dataUrl.slice(match[0].length) : null
}
