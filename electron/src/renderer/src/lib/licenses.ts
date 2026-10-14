/**
 * What Settings ▸ About shows of the licenses: the GPL's text for the License
 * row, and the notices THIRD_PARTY_NOTICES.txt carries, one entry per
 * component. Both come from `bin/notices` (licenses.json) with the file, so the
 * two never disagree.
 *
 * The JSON carries every license text (~300 KB), so it is its own chunk,
 * loaded when About is shown; the module cache makes later loads free.
 */

export interface LicenseEntry {
  name: string
  version: string | null
  /** SPDX expression; null for a built component whose notice states none. */
  license: string | null
  source: string | null
  text: string
  featured: boolean
  /** Set on a row that links out instead of opening (Chromium). */
  link?: string
}

export interface Licenses {
  /** GoatCAD's own license, the repository's LICENSE. */
  gpl: string
  components: LicenseEntry[]
}

export const loadLicenses = async (): Promise<Licenses> =>
  (await import('./licenses.json')).default as Licenses
